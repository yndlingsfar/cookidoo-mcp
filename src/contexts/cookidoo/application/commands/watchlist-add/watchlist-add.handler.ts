import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

import {
  COOKIDOO_CLIENT,
  ICookidooClient,
} from '@contexts/cookidoo/domain/interfaces/cookidoo-client.interface';
import { WatchlistAddCommand } from './watchlist-add.command';

@CommandHandler(WatchlistAddCommand)
export class WatchlistAddCommandHandler implements ICommandHandler<WatchlistAddCommand> {
  constructor(
    @Inject(COOKIDOO_CLIENT) private readonly client: ICookidooClient,
  ) {}

  async execute(command: WatchlistAddCommand): Promise<void> {
    await this.client.addRecipesToWatchlist(command.recipeIds);
  }
}
