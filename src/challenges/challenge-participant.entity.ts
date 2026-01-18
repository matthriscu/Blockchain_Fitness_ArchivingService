import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'challenge_participants' })
@Index(['challengeId'])
export class ChallengeParticipantEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  challengeId!: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  address!: string;

  @Column({ type: 'text', default: '0' })
  score!: string;

  @Column({ type: 'datetime', nullable: true })
  joinedAt?: Date;

  @Column({ type: 'varchar', length: 64 })
  joinTxHash!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lastUpdateTxHash?: string;

  @Column({ type: 'datetime', nullable: true })
  lastScoreChangeAt?: Date;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
