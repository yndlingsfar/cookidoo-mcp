import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { McpTool } from '@core/mcp/domain/decorators/mcp-tool.decorator';
import { IMcpTool } from '@core/mcp/domain/interfaces/mcp-tool.interface';
import { WatchlistAddCommand } from '@contexts/cookidoo/application/commands/watchlist-add/watchlist-add.command';
import { watchlistRecipeIdsSchema } from '../schemas/watchlist.schema';

@McpTool()
@Injectable()
export class WatchlistAddMcpTool implements IMcpTool {
  private readonly logger = new Logger(WatchlistAddMcpTool.name);

  readonly name = 'cookidoo_add_to_watchlist';
  readonly title = 'Add recipes to watchlist (Merkliste)';
  readonly description =
    'Adds the given recipes to the watchlist ("Merkliste"). Note: the watchlist has a capacity limit on the Cookidoo side.';
  readonly inputSchema = watchlistRecipeIdsSchema;

  constructor(private readonly commandBus: CommandBus) {}

  async execute(args: Record<string, unknown>): Promise<CallToolResult> {
    const { recipeIds } = args as { recipeIds: string[] };
    this.logger.log(`Adding ${recipeIds.length} recipe(s) to the watchlist`);
    await this.commandBus.execute(new WatchlistAddCommand({ recipeIds }));
    return {
      content: [
        { type: 'text', text: JSON.stringify({ added: recipeIds.length }) },
      ],
    };
  }
}
