import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';
import { ChallengeEntity } from './challenges/challenge.entity';
import { ChallengeParticipantEntity } from './challenges/challenge-participant.entity';

interface RawTransaction {
  txHash?: string;
  hash?: string;
  tx_hash?: string;
  identifier?: string;
  _id?: string;
  sender?: string;
  receiver?: string;
  data?: string;
  timestamp?: number | string;
  timestampMs?: number | string;
  [key: string]: unknown;
}

interface DecodedCallData {
  functionName: string;
  args: string[];
}

interface NormalizedTransaction {
  txHash: string;
  sender?: string;
  receiver?: string;
  data?: string;
  timestamp?: number;
  timestampMs?: number;
  raw: RawTransaction;
}

@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppService.name);
  private readonly contractAddress: string;
  private readonly contractAddressLower: string;
  private readonly gatewayApiUrl: string;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly trackedFunctions = new Set([
    'createChallenge',
    'joinChallenge',
    'submitWorkout',
    'closeChallenge',
  ]);
  private readonly processedTxCacheLimit = 500;
  private readonly processedTxHashes = new Set<string>();
  private readonly processedTxQueue: string[] = [];
  private latestTimestampMs?: number;
  private pollTimer?: NodeJS.Timeout;
  private syncInProgress = false;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @InjectRepository(ChallengeEntity)
    private readonly challengeRepository: Repository<ChallengeEntity>,
    @InjectRepository(ChallengeParticipantEntity)
    private readonly participantRepository: Repository<ChallengeParticipantEntity>,
  ) {
    this.contractAddress = this.requireConfig('CHALLENGE_CONTRACT_ADDRESS');
    this.contractAddressLower = this.contractAddress.toLowerCase();
    this.gatewayApiUrl = this.normalizeGatewayUrl(
      this.configService.get<string>('GATEWAY_API_URL'),
    );
    this.batchSize = Number(this.configService.get<number>('TX_FETCH_SIZE')) || 25;
    this.pollIntervalMs =
      Number(this.configService.get<number>('TX_POLL_INTERVAL_MS')) || 30_000;
  }

  async onModuleInit() {
    await this.pipeContractActivity();
    this.startPollingLoop();
  }

  onModuleDestroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pipeContractActivity() {
    if (this.syncInProgress) {
      this.logger.debug('Sync already in progress; skipping this cycle.');
      return;
    }
    this.syncInProgress = true;

    try {
      const transactions = await this.fetchRecentTransactions();
      await this.processFitnessContractTransactions(transactions);
      this.logger.log(
        `Synced ${transactions.length} transactions from ${this.contractAddress}.`,
      );
    } catch (error) {
      this.logger.error(
        'Failed to pipe contract activity into the database.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.syncInProgress = false;
    }
  }

  private startPollingLoop() {
    if (this.pollIntervalMs <= 0) {
      this.logger.warn('Polling disabled because TX_POLL_INTERVAL_MS <= 0.');
      return;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(() => {
      void this.pipeContractActivity();
    }, this.pollIntervalMs);

    this.logger.log(
      `Started polling loop (interval ${this.pollIntervalMs} ms).`,
    );
  }

  private async fetchRecentTransactions() {
    const apiUrl = `${this.gatewayApiUrl}/accounts/${this.contractAddress}/transactions`;

    try {
      const { data } = await firstValueFrom(
        this.httpService.get<RawTransaction[]>(apiUrl, {
          params: {
            size: this.batchSize,
            order: 'desc',
            withScResults: true,
          },
        }),
      );

      if (!Array.isArray(data) || data.length === 0) {
        return [];
      }

      const normalized = data
        .map((tx) => this.normalizeRawTransaction(tx))
        .filter(
          (tx): tx is NormalizedTransaction =>
            Boolean(tx) && this.matchesContract(tx.receiver),
        );

      return normalized.sort(
        (a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0),
      );
    } catch (error) {
      throw new HttpException(
        error.response?.data || 'Error fetching contract transactions',
        error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async processFitnessContractTransactions(
    transactions: NormalizedTransaction[],
  ) {
    if (!transactions.length) {
      return;
    }

    const novelTransactions = this.filterNovelTransactions(transactions);
    if (!novelTransactions.length) {
      return;
    }

    for (const tx of novelTransactions) {
      try {
        const decoded = this.decodeTransactionData(tx.data);
        if (!decoded || !this.trackedFunctions.has(decoded.functionName)) {
          continue;
        }

        switch (decoded.functionName) {
          case 'createChallenge':
            await this.handleChallengeCreated(tx, decoded.args);
            break;
          case 'closeChallenge':
            await this.handleChallengeClosed(tx);
            break;
          case 'joinChallenge':
            await this.handleJoinChallenge(tx);
            break;
          case 'submitWorkout':
            await this.handleWorkoutSubmitted(tx, decoded.args);
            break;
          default:
            break;
        }
      } catch (error) {
        this.logger.error(
          `Failed to process transaction ${tx.txHash}.`,
          error instanceof Error ? error.stack : String(error),
        );
        continue;
      } finally {
        this.markTransactionProcessed(tx);
      }
    }
  }

  private async handleChallengeCreated(
    tx: NormalizedTransaction,
    args: string[],
  ) {
    const alreadyArchived = await this.challengeRepository.exist({
      where: { id: tx.txHash },
    });
    if (alreadyArchived) {
      return;
    }

    const start = this.parseHexToBigInt(args?.[0]);
    const end = this.parseHexToBigInt(args?.[1]);

    if (start === undefined || end === undefined) {
      this.logger.warn(
        `Skipping challenge recording for ${tx.txHash} because timestamps are missing.`,
      );
      return;
    }

    const rewardBudget = this.parseHexToBigInt(args?.[2]) ?? 0n;
    const rewardPerPoint = this.parseHexToBigInt(args?.[3]) ?? 0n;

    await this.challengeRepository.update(
      { active: true },
      { active: false, lastUpdatedTxHash: tx.txHash },
    );

    const entity = this.challengeRepository.create({
      id: tx.txHash,
      creator: tx.sender ?? 'unknown',
      startTimestamp: this.safeNumberFromBigInt(start) ?? 0,
      endTimestamp: this.safeNumberFromBigInt(end) ?? 0,
      rewardBudget: rewardBudget.toString(),
      rewardPerPoint: rewardPerPoint.toString(),
      active: true,
      createdTxHash: tx.txHash,
      lastUpdatedTxHash: tx.txHash,
      openedAt: this.toDateFromTx(tx),
    });

    await this.challengeRepository.save(entity);
    this.logger.log(
      `Archived challenge ${entity.id} (${entity.startTimestamp} -> ${entity.endTimestamp}).`,
    );
  }

  private async handleChallengeClosed(tx: NormalizedTransaction) {
    const activeChallenge = await this.getActiveChallenge();
    if (!activeChallenge) {
      return;
    }

    if (activeChallenge.lastUpdatedTxHash === tx.txHash) {
      return;
    }

    activeChallenge.active = false;
    activeChallenge.closedTxHash = tx.txHash;
    activeChallenge.lastUpdatedTxHash = tx.txHash;
    activeChallenge.closedAt = this.toDateFromTx(tx);

    await this.challengeRepository.save(activeChallenge);
    this.logger.log(`Marked challenge ${activeChallenge.id} as closed.`);
  }

  private async handleJoinChallenge(tx: NormalizedTransaction) {
    if (!tx.sender) {
      this.logger.warn(
        `Skipping joinChallenge for ${tx.txHash} because sender is missing.`,
      );
      return;
    }

    const challenge = await this.getActiveChallenge();
    if (!challenge) {
      this.logger.warn(
        `Received joinChallenge for ${tx.txHash} but no active challenge was found.`,
      );
      return;
    }

    const participant = await this.participantRepository.findOne({
      where: { challengeId: challenge.id, address: tx.sender },
    });

    if (participant?.joinTxHash === tx.txHash) {
      return;
    }

    const payload = this.participantRepository.create({
      challengeId: challenge.id,
      address: tx.sender,
      score: participant?.score ?? '0',
      joinTxHash: tx.txHash,
      joinedAt: this.toDateFromTx(tx) ?? participant?.joinedAt,
      lastUpdateTxHash: participant?.lastUpdateTxHash,
      lastScoreChangeAt: participant?.lastScoreChangeAt,
    });

    await this.participantRepository.save(payload);
    this.logger.log(
      `Participant ${tx.sender} joined challenge ${challenge.id}.`,
    );
  }

  private async handleWorkoutSubmitted(
    tx: NormalizedTransaction,
    args: string[],
  ) {
    if (!tx.sender) {
      this.logger.warn(
        `Skipping submitWorkout for ${tx.txHash} because sender is missing.`,
      );
      return;
    }

    const challenge = await this.getActiveChallenge();
    if (!challenge) {
      this.logger.warn(
        `submitWorkout ${tx.txHash} ignored because no active challenge exists.`,
      );
      return;
    }

    const points = this.parseHexToBigInt(args?.[0]);
    if (points === undefined) {
      this.logger.warn(
        `submitWorkout ${tx.txHash} payload is missing the points argument.`,
      );
      return;
    }

    const participant = await this.participantRepository.findOne({
      where: { challengeId: challenge.id, address: tx.sender },
    });

    if (participant?.lastUpdateTxHash === tx.txHash) {
      return;
    }

    const currentScore = BigInt(participant?.score ?? '0');
    const updatedScore = (currentScore + points).toString();

    const payload = this.participantRepository.create({
      challengeId: challenge.id,
      address: tx.sender,
      score: updatedScore,
      joinTxHash: participant?.joinTxHash ?? tx.txHash,
      joinedAt: participant?.joinedAt ?? this.toDateFromTx(tx),
      lastUpdateTxHash: tx.txHash,
      lastScoreChangeAt: this.toDateFromTx(tx),
    });

    await this.participantRepository.save(payload);
    this.logger.log(
      `Recorded ${points.toString()} points for participant ${tx.sender} on challenge ${challenge.id}.`,
    );
  }

  private normalizeRawTransaction(
    tx: RawTransaction,
  ): NormalizedTransaction | undefined {
    if (!tx) {
      return undefined;
    }

    const txHash =
      tx.txHash || tx.hash || tx.tx_hash || tx.identifier || tx._id;
    if (!txHash) {
      return undefined;
    }

    const timestamp = this.parsePossibleNumber(tx.timestamp);
    const timestampMs =
      this.parsePossibleNumber(tx.timestampMs) ??
      (timestamp !== undefined ? timestamp * 1000 : undefined);

    return {
      txHash,
      sender: tx.sender,
      receiver: tx.receiver,
      data: tx.data,
      timestamp,
      timestampMs,
      raw: tx,
    };
  }

  private decodeTransactionData(data?: string): DecodedCallData | undefined {
    if (!data) {
      return undefined;
    }

    try {
      const decoded = Buffer.from(data, 'base64').toString('utf8');
      const parts = decoded.split('@');
      if (!parts.length || !parts[0]) {
        return undefined;
      }
      const [functionName, ...args] = parts;
      return { functionName, args: args.filter((arg) => arg.length > 0) };
    } catch {
      this.logger.warn('Encountered a transaction payload that could not be decoded.');
      return undefined;
    }
  }

  private parseHexToBigInt(value?: string): bigint | undefined {
    if (!value || value.length === 0) {
      return undefined;
    }

    const normalized = value.startsWith('0x') ? value.slice(2) : value;
    if (!normalized.length) {
      return undefined;
    }

    return BigInt(`0x${normalized}`);
  }

  private safeNumberFromBigInt(value?: bigint): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (value > max) {
      return Number(max);
    }

    return Number(value);
  }

  private parsePossibleNumber(input: unknown): number | undefined {
    if (typeof input === 'number') {
      return Number.isFinite(input) ? input : undefined;
    }

    if (typeof input === 'string' && input.length) {
      const parsed = Number(input);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private matchesContract(address?: string) {
    return Boolean(address && address.toLowerCase() === this.contractAddressLower);
  }

  private toDateFromTx(tx: NormalizedTransaction) {
    const ms =
      tx.timestampMs ??
      (tx.timestamp !== undefined ? tx.timestamp * 1000 : undefined);
    return ms ? new Date(ms) : undefined;
  }

  private getActiveChallenge() {
    return this.challengeRepository.findOne({
      where: { active: true },
      order: { startTimestamp: 'DESC' },
    });
  }

  private normalizeGatewayUrl(explicit?: string) {
    const trimmed = explicit?.trim();
    if (!trimmed) {
      return 'https://api.multiversx.com';
    }

    return trimmed.replace(/\/+$/, '');
  }

  private filterNovelTransactions(transactions: NormalizedTransaction[]) {
    return transactions.filter((tx) => {
      if (this.processedTxHashes.has(tx.txHash)) {
        return false;
      }

      if (this.latestTimestampMs === undefined) {
        return true;
      }

      const timestamp = tx.timestampMs ?? tx.timestamp ?? 0;
      return timestamp >= this.latestTimestampMs;
    });
  }

  private markTransactionProcessed(tx: NormalizedTransaction) {
    const timestamp = tx.timestampMs ?? tx.timestamp ?? 0;
    this.latestTimestampMs = Math.max(this.latestTimestampMs ?? 0, timestamp);

    if (this.processedTxHashes.has(tx.txHash)) {
      return;
    }

    this.processedTxHashes.add(tx.txHash);
    this.processedTxQueue.push(tx.txHash);

    if (this.processedTxQueue.length > this.processedTxCacheLimit) {
      const oldest = this.processedTxQueue.shift();
      if (oldest) {
        this.processedTxHashes.delete(oldest);
      }
    }
  }

  private requireConfig(key: string) {
    const value = this.configService.get<string>(key)?.trim();
    if (!value) {
      throw new Error(`${key} environment variable is required.`);
    }
    return value;
  }
}
