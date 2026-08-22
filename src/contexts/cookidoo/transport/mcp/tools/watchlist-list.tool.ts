import { Injectable, Logger } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { McpTool } from '@core/mcp/domain/decorators/mcp-tool.decorator';
import { IMcpTool } from '@core/mcp/domain/interfaces/mcp-tool.interface';
import { WatchlistFindAllQuery } from '@contexts/cookidoo/application/queries/watchlist-find-all/watchlist-find-all.query';

@McpTool()
@Injectable()
export class WatchlistListMcpTool implements IMcpTool {
  private readonly logger = new Logger(WatchlistListMcpTool.name);

  readonly name = 'cookidoo_get_watchlist';
  readonly title = 'Get watchlist (Merkliste)';
  readonly description =
    'Returns all recipes on the watchlist ("Merkliste") — the quick-save bookmark list under "Meine Rezepte" — with recipe id, title, preparation time and image.';
  readonly inputSchema = {};

  constructor(private readonly queryBus: QueryBus) {}

  async execute(): Promise<CallToolResult> {
    this.logger.log('Loading watchlist');
    const result = await this.queryBus.execute(new WatchlistFindAllQuery());
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
}
