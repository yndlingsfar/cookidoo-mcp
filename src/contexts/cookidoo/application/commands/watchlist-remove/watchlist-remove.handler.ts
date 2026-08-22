import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

import {
  COOKIDOO_CLIENT,
  ICookidooClient,
} from '@contexts/cookidoo/domain/interfaces/cookidoo-client.interface';
import { WatchlistRemoveCommand } from './watchlist-remove.command';

@CommandHandler(WatchlistRemoveCommand)
export class WatchlistRemoveCommandHandler implements ICommandHandler<WatchlistRemoveCommand> {
  constructor(
    @Inject(COOKIDOO_CLIENT) private readonly client: ICookidooClient,
  ) {}

  async execute(command: WatchlistRemoveCommand): Promise<void> {
    await this.client.removeRecipesFromWatchlist(command.recipeIds);
  }
}
