import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '@multiversx/sdk-nestjs-cache';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
 private readonly size = 10;
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
  ) {}

  async getLatestTransactions() {
    const isCachingEnabled = this.configService.get<string>('CACHING_ENABLED') === 'true';
    
    
    // Define the cache key and expiration time (6 seconds = 1 block time)
    const cacheKey = `latest:transactions:${this.size}`;
    const ttlSeconds = 6; 

    // Conditional logic based on configuration
    if (isCachingEnabled) {
      return await this.cacheService.getOrSet(
        cacheKey,
        async () => await this.fetchTransactionsFromApi(),
        ttlSeconds,
      );
    } else {
      return await this.fetchTransactionsFromApi();
    }
  }

  /**
   * Private method to execute the actual HTTP request to the MultiversX API.
   * This acts as the "remote fetcher" for the cache service.
   */
  private async fetchTransactionsFromApi() {
    const apiUrl = 'https://api.multiversx.com/transactions';
    
    this.logger.warn('🌍 CACHE MISS -> Executing external API request to MultiversX...');

    try {
      const { data } = await firstValueFrom(
        this.httpService.get(apiUrl, {
          params: {
            size: this.size,
            order: 'desc',
          },
        }),
      );

      if (Array.isArray(data)) {
        const txHashes = data.map((tx: any) => tx.txHash);
        this.logger.log(`Received ${txHashes.length} transactions. Hashes:`);
        console.log(txHashes);
      }

      return data;
    } catch (error) {
      this.logger.error('Failed to fetch transactions');
      throw new HttpException(
        error.response?.data || 'Error fetching transactions',
        error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}