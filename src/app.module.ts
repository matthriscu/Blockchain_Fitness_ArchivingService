import { Module } from '@nestjs/common';
import { AppService } from './app.service';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChallengeEntity } from './challenges/challenge.entity';
import { ChallengeParticipantEntity } from './challenges/challenge-participant.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'sqlite',
        database: config.get<string>('DATABASE_PATH') || 'transactions.sqlite',
        autoLoadEntities: true,
        synchronize: true,
      }),
    }),
    TypeOrmModule.forFeature([ChallengeEntity, ChallengeParticipantEntity]),
    HttpModule,
  ],
  controllers: [],
  providers: [AppService],
})
export class AppModule {}
