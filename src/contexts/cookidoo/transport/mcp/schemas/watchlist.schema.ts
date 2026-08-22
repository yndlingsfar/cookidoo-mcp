import { z } from 'zod';

/** Input schema for adding/removing recipes on the watchlist ("Merkliste"). */
export const watchlistRecipeIdsSchema = {
  recipeIds: z
    .array(z.string().min(1))
    .min(1)
    .describe('Ids of the recipes to add to / remove from the watchlist'),
};
