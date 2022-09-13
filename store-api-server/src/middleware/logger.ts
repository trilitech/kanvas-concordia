import { Request, Response, NextFunction } from 'express';
import {
  Injectable,
  Inject,
  CACHE_MANAGER,
  NestMiddleware,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Cache } from 'cache-manager';
import { CACHE_SIZE, BEHIND_PROXY, API_KEY_SECRET } from '../constants.js';
import { getClientIp } from '../utils.js';

@Injectable()
export class StatsLogger {
  private logger = new Logger('STATS');
  constructor(@Inject(CACHE_MANAGER) private cache: Cache) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async logStats() {
    const store: any = this.cache.store;

    const countFunc = store.itemCount;
    const pruneFunc = store.prune;
    if (typeof countFunc === 'undefined' || typeof pruneFunc === 'undefined') {
      this.logger.warn(
        'cannot log cache statistics, "itemCount" or "prune" function is undefined',
      );
      return;
    }

    await store.prune();
    const itemCount = await countFunc();
    this.logger.log(`cache size: ${itemCount}/${CACHE_SIZE}`);
  }
}

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  private logger = new Logger('HTTP');

  constructor() {}

  use(request: Request, response: Response, next: NextFunction): void {
    const { ip, method, originalUrl } = request;
    const userAgent = request.get('user-agent') || '';
    const cookieSession = request.session?.uuid.slice(0, 5) || '';
    const clientIp = getClientIp(request);
    const timeStart = new Date();

    const fields = [
      method,
      originalUrl,
      userAgent,
      clientIp,
      `sess:${cookieSession}`,
    ];

    if (
      typeof API_KEY_SECRET === 'string' &&
      request.headers['api-key'] === API_KEY_SECRET
    ) {
      fields.push('api-key');
    }

    let resultDelimiterPushed = false;
    const pushResultDelimiter = () => {
      if (!resultDelimiterPushed) {
        fields.push('=>');
      }
      resultDelimiterPushed = true;
    };

    response.on('error', (err) => {
      pushResultDelimiter();
      fields.push(`-err: ${err}-`);
    });

    response.on('close', () => {
      pushResultDelimiter();
      fields.push('-client aborted-');
    });

    response.on('finish', () => {
      const timeEnd: Date = new Date();
      const duration = `${timeEnd.getTime() - timeStart.getTime()}ms`;
      const { statusCode } = response;
      const contentLength = response.get('content-length');

      pushResultDelimiter();
      fields.push(`${statusCode}`);
      fields.push(contentLength);
      fields.push(duration);

      switch (response.get('cached')) {
        case 'yes':
          fields.push('cached');
          break;
        case 'no':
          fields.push('uncached');
          break;
      }

      this.logger.log(fields.join(' '));
    });

    next();
  }
}
