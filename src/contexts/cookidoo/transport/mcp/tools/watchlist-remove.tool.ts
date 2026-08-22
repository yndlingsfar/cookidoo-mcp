import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { McpTool } from '@core/mcp/domain/decorators/mcp-tool.decorator';
import { IMcpTool } from '@core/mcp/domain/interfaces/mcp-tool.interface';
import { WatchlistRemoveCommand } from '@contexts/cookidoo/application/commands/watchlist-remove/watchlist-remove.command';
import { watchlistRecipeIdsSchema } from '../schemas/watchlist.schema';

@McpTool()
@Injectable()
export class WatchlistRemoveMcpTool implements IMcpTool {
  private readonly logger = new Logger(WatchlistRemoveMcpTool.name);

  readonly name = 'cookidoo_remove_from_watchlist';
  readonly title = 'Remove recipes from watchlist (Merkliste)';
  readonly description =
    'Removes the given recipes from the watchlist ("Merkliste").';
  readonly inputSchema = watchlistRecipeIdsSchema;

  constructor(private readonly commandBus: CommandBus) {}

  async execute(args: Record<string, unknown>): Promise<CallToolResult> {
    const { recipeIds } = args as { recipeIds: string[] };
    this.logger.log(
      `Removing ${recipeIds.length} recipe(s) from the watchlist`,
    );
    await this.commandBus.execute(new WatchlistRemoveCommand({ recipeIds }));
    return {
      content: [
        { type: 'text', text: JSON.stringify({ removed: recipeIds.length }) },
      ],
    };
  }
}
