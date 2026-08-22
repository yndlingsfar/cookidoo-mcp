import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import {
  COOKIDOO_CLIENT,
  ICookidooClient,
} from '@contexts/cookidoo/domain/interfaces/cookidoo-client.interface';
import { CookidooWatchlistItem } from '@contexts/cookidoo/domain/types/cookidoo-watchlist.type';
import { WatchlistFindAllQuery } from './watchlist-find-all.query';

@QueryHandler(WatchlistFindAllQuery)
export class WatchlistFindAllQueryHandler implements IQueryHandler<WatchlistFindAllQuery> {
  constructor(
    @Inject(COOKIDOO_CLIENT) private readonly client: ICookidooClient,
  ) {}

  async execute(): Promise<CookidooWatchlistItem[]> {
    return this.client.getWatchlist();
  }
}
