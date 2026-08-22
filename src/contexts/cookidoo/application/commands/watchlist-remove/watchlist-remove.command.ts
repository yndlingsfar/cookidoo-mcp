/** Command: remove recipes from the watchlist ("Merkliste"). */
export class WatchlistRemoveCommand {
  public readonly recipeIds: string[];

  constructor(input: { recipeIds: string[] }) {
    this.recipeIds = input.recipeIds;
  }
}
