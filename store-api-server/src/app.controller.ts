import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service.js';
import { AppConstants } from './app.entity.js';

@Controller('/')
export class AppController {
  constructor(private appService: AppService) {}

  @Get('/constants')
  getConstants(): AppConstants {
    return this.appService.getConstants();
  }
}
