/**
 * An entry on the Cookidoo watchlist ("Merkliste") — the quick-save bookmark
 * list under "Meine Rezepte". Distinct from collections/recipe lists.
 */
export interface CookidooWatchlistItem {
  /** Bookmark id (`FAV-…`), distinct from the recipe id. */
  readonly bookmarkId: string;
  /** Recipe id (`r…`) — what add/remove operate on. */
  readonly recipeId: string;
  /** Recipe title, or `null` if the API omitted it. */
  readonly name: string | null;
  /** Preparation time in seconds, or `null` if unknown. */
  readonly totalTime: number | null;
  /** Landscape image URL, or `null`. */
  readonly image: string | null;
  /** Recipe locale (e.g. `de-DE`), or `null`. */
  readonly locale: string | null;
}
