import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheModule, RedisCacheModuleOptions } from '@multiversx/sdk-nestjs-cache';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HttpModule,
    CacheModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => 
        new RedisCacheModuleOptions({
        host: config.get<string>('REDIS_HOST') || 'localhost',
        port: config.get<number>('REDIS_PORT') || 6379,
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}