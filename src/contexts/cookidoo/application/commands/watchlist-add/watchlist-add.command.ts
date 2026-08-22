/** Command: add recipes to the watchlist ("Merkliste"). */
export class WatchlistAddCommand {
  public readonly recipeIds: string[];

  constructor(input: { recipeIds: string[] }) {
    this.recipeIds = input.recipeIds;
  }
}
