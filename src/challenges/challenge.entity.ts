import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'challenges' })
@Index(['active'])
export class ChallengeEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id!: string; // creation transaction hash

  @Column({ type: 'varchar', length: 64 })
  creator!: string;

  @Column({ type: 'integer' })
  startTimestamp!: number;

  @Column({ type: 'integer' })
  endTimestamp!: number;

  @Column({ type: 'text' })
  rewardBudget!: string;

  @Column({ type: 'text' })
  rewardPerPoint!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'varchar', length: 64 })
  createdTxHash!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  closedTxHash?: string;

  @Column({ type: 'varchar', length: 64 })
  lastUpdatedTxHash!: string;

  @Column({ type: 'datetime', nullable: true })
  openedAt?: Date;

  @Column({ type: 'datetime', nullable: true })
  closedAt?: Date;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
