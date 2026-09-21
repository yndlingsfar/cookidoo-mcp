import { CookidooLocalization } from '@core/config/cookidoo.config';
import {
  additionalItemFromJson,
  calendarDayFromJson,
  collectionFromJson,
  constructRecipeUrl,
  customRecipeFromJson,
  durationToSeconds,
  ingredientItemFromJson,
  recipeDetailsFromJson,
  searchResultFromJson,
  shoppingRecipeFromJson,
  subscriptionFromJson,
  userInfoFromJson,
  watchlistItemFromJson,
} from './cookidoo.mappers';

const localization: CookidooLocalization = {
  countryCode: 'ch',
  language: 'de-CH',
  url: 'https://cookidoo.ch/foundation/de-CH',
};

describe('cookidoo mappers', () => {
  describe('constructRecipeUrl', () => {
    it('builds a localized recipe URL on the cookidoo domain', () => {
      expect(constructRecipeUrl(localization, 'r123')).toBe(
        'https://cookidoo.ch/recipes/recipe/de-CH/r123',
      );
    });
  });

  describe('userInfoFromJson', () => {
    it('maps the community profile, defaulting missing fields to null', () => {
      const result = userInfoFromJson({
        id: 'u1',
        userInfo: { username: 'chef', picture: 'http://img' },
      });

      expect(result).toEqual({
        id: 'u1',
        username: 'chef',
        description: null,
        picture: 'http://img',
      });
    });
  });

  describe('subscriptionFromJson', () => {
    it('maps the API field names to the domain shape', () => {
      const result = subscriptionFromJson({
        active: true,
        expires: '2027-01-01',
        startDate: '2026-01-01',
        status: 'ACTIVE',
        subscriptionLevel: 'PREMIUM',
        subscriptionSource: 'WEB',
        type: 'PAID',
        extendedType: 'PAID_EXTENDED',
      });

      expect(result.active).toBe(true);
      expect(result.startDate).toBe('2026-01-01');
      expect(result.subscriptionLevel).toBe('PREMIUM');
    });
  });

  describe('ingredientItemFromJson', () => {
    it('builds a "quantity unit" description', () => {
      const result = ingredientItemFromJson({
        id: 'i1',
        ingredientNotation: 'flour',
        isOwned: false,
        quantity: { value: 200 },
        unitNotation: 'g',
      });

      expect(result).toEqual({
        id: 'i1',
        name: 'flour',
        isOwned: false,
        description: '200 g',
      });
    });

    it('renders a from/to range when there is no single value', () => {
      const result = ingredientItemFromJson({
        id: 'i2',
        ingredientNotation: 'water',
        isOwned: true,
        quantity: { from: 1, to: 2 },
        unitNotation: 'l',
      });

      expect(result.description).toBe('1 - 2 l');
      expect(result.isOwned).toBe(true);
    });
  });

  describe('additionalItemFromJson', () => {
    it('maps id, name and owned flag', () => {
      expect(
        additionalItemFromJson({ id: 'a1', name: 'milk', isOwned: true }),
      ).toEqual({ id: 'a1', name: 'milk', isOwned: true });
    });
  });

  describe('shoppingRecipeFromJson', () => {
    it('maps ingredients and image variants', () => {
      const result = shoppingRecipeFromJson(
        {
          id: 'r1',
          title: 'Soup',
          recipeIngredientGroups: [
            {
              id: 'i1',
              ingredientNotation: 'carrot',
              quantity: { value: 3 },
              unitNotation: '',
            },
          ],
          descriptiveAssets: [{ square: 'http://img/{transformation}.jpg' }],
        },
        localization,
      );

      expect(result.id).toBe('r1');
      expect(result.name).toBe('Soup');
      expect(result.ingredients).toHaveLength(1);
      expect(result.ingredients[0].description).toBe('3');
      expect(result.thumbnail).toContain('t_web_shared_recipe_221x240');
      expect(result.image).toContain('t_web_rdp_recipe_584x480_1_5x');
      expect(result.url).toBe('https://cookidoo.ch/recipes/recipe/de-CH/r1');
    });
  });

  describe('recipeDetailsFromJson', () => {
    it('flattens ingredient groups and extracts times/notes/utensils', () => {
      const result = recipeDetailsFromJson(
        {
          id: 'r2',
          title: 'Cake',
          difficulty: 'easy',
          recipeIngredientGroups: [
            {
              recipeIngredients: [
                {
                  id: 'i1',
                  ingredientNotation: 'sugar',
                  quantity: { value: 100 },
                  unitNotation: 'g',
                },
              ],
            },
          ],
          additionalInformation: [{ content: 'Preheat oven' }],
          recipeUtensils: [{ utensilNotation: 'bowl' }],
          servingSize: { quantity: { value: 8 } },
          times: [
            { type: 'activeTime', quantity: { value: 600 } },
            { type: 'totalTime', quantity: { value: 3600 } },
          ],
        },
        localization,
      );

      expect(result.ingredients).toHaveLength(1);
      expect(result.difficulty).toBe('easy');
      expect(result.notes).toEqual(['Preheat oven']);
      expect(result.utensils).toEqual(['bowl']);
      expect(result.servingSize).toBe(8);
      expect(result.activeTime).toBe(600);
      expect(result.totalTime).toBe(3600);
    });

    it('falls back to null times when not present', () => {
      const result = recipeDetailsFromJson(
        { id: 'r3', title: 'Quick', recipeIngredientGroups: [] },
        localization,
      );

      expect(result.activeTime).toBeNull();
      expect(result.totalTime).toBeNull();
      expect(result.servingSize).toBe(0);
    });

    it('maps nutrition values and preserves the basis they refer to', () => {
      const result = recipeDetailsFromJson(
        {
          id: 'r4',
          title: 'Soup',
          recipeIngredientGroups: [],
          nutritionGroups: [
            {
              name: '',
              recipeNutritions: [
                {
                  quantity: 1,
                  unitNotation: 'Portion',
                  nutritions: [
                    { type: 'kcal', number: 229, unittype: 'kcal' },
                    { type: 'fat', number: 14, unittype: 'g' },
                    { type: 'carb2', number: 19, unittype: 'g' },
                  ],
                },
              ],
            },
          ],
        },
        localization,
      );

      expect(result.nutrition).toEqual({
        basisQuantity: 1,
        basisUnit: 'Portion',
        values: [
          { type: 'kcal', number: 229, unit: 'kcal' },
          { type: 'fat', number: 14, unit: 'g' },
          { type: 'carb2', number: 19, unit: 'g' },
        ],
      });
    });

    it('keeps a per-100g basis instead of assuming portions', () => {
      const result = recipeDetailsFromJson(
        {
          id: 'r5',
          title: 'Spread',
          recipeIngredientGroups: [],
          nutritionGroups: [
            {
              recipeNutritions: [
                {
                  quantity: 100,
                  unitNotation: 'g',
                  nutritions: [{ type: 'kcal', number: 560, unittype: 'kcal' }],
                },
              ],
            },
          ],
        },
        localization,
      );

      expect(result.nutrition?.basisQuantity).toBe(100);
      expect(result.nutrition?.basisUnit).toBe('g');
    });

    it('returns null nutrition when the recipe reports none', () => {
      const result = recipeDetailsFromJson(
        { id: 'r6', title: 'Unknown', recipeIngredientGroups: [] },
        localization,
      );

      expect(result.nutrition).toBeNull();
    });

    it('returns null nutrition when the groups contain no usable figures', () => {
      const result = recipeDetailsFromJson(
        {
          id: 'r7',
          title: 'Empty',
          recipeIngredientGroups: [],
          nutritionGroups: [{ recipeNutritions: [{ nutritions: [] }] }],
        },
        localization,
      );

      expect(result.nutrition).toBeNull();
    });

    it('flattens preparation steps and strips NOBR markup', () => {
      const result = recipeDetailsFromJson(
        {
          id: 'r8',
          title: 'Soup',
          recipeIngredientGroups: [],
          recipeStepGroups: [
            {
              title: '',
              recipeSteps: [
                {
                  title: '1',
                  formattedText:
                    'Add <NOBR>100 g potatoes</NOBR> and cook <nobr>14 min/Varoma/speed 1</nobr>.',
                },
                { title: '2', formattedText: 'Blend for 8 sec/speed 5.' },
              ],
            },
          ],
        },
        localization,
      );

      expect(result.steps).toEqual([
        {
          group: null,
          number: '1',
          text: 'Add 100 g potatoes and cook 14 min/Varoma/speed 1.',
        },
        { group: null, number: '2', text: 'Blend for 8 sec/speed 5.' },
      ]);
    });

    it('keeps non-empty group titles on every step of the group', () => {
      const result = recipeDetailsFromJson(
        {
          id: 'r9',
          title: 'Cake',
          recipeIngredientGroups: [],
          recipeStepGroups: [
            {
              title: 'Dough',
              recipeSteps: [{ title: '1', formattedText: 'Mix.' }],
            },
            {
              title: 'Topping',
              recipeSteps: [{ title: '1', formattedText: 'Whip.' }],
            },
          ],
        },
        localization,
      );

      expect(result.steps).toEqual([
        { group: 'Dough', number: '1', text: 'Mix.' },
        { group: 'Topping', number: '1', text: 'Whip.' },
      ]);
    });

    it('returns an empty step list when the recipe reports none', () => {
      const result = recipeDetailsFromJson(
        { id: 'r10', title: 'Unknown', recipeIngredientGroups: [] },
        localization,
      );

      expect(result.steps).toEqual([]);
    });
  });

  describe('searchResultFromJson', () => {
    it('reads recipes from the `data` key and reports the total', () => {
      const result = searchResultFromJson(
        {
          data: [
            { id: 'r1', title: 'A' },
            { id: 'r2', name: 'B' },
          ],
          total: 42,
        },
        localization,
      );

      expect(result.total).toBe(42);
      expect(result.recipes.map((r) => r.name)).toEqual(['A', 'B']);
      expect(result.recipes[0].url).toBe(
        'https://cookidoo.ch/recipes/recipe/de-CH/r1',
      );
    });

    it('defaults total to the number of hits when absent', () => {
      const result = searchResultFromJson(
        { recipes: [{ id: 'r1', title: 'A' }] },
        localization,
      );

      expect(result.total).toBe(1);
    });
  });

  describe('calendarDayFromJson', () => {
    it('merges regular and custom recipes and maps their fields', () => {
      const result = calendarDayFromJson(
        {
          id: '2026-06-26',
          title: 'Friday',
          recipes: [
            {
              id: 'r1',
              title: 'Soup',
              totalTime: 1800,
              assets: { images: { square: 'http://img/{transformation}.jpg' } },
            },
          ],
          customerRecipes: [{ id: 'c1', title: 'My dish', totalTime: null }],
          customerRecipeIds: ['c1'],
        },
        localization,
      );

      expect(result.id).toBe('2026-06-26');
      expect(result.title).toBe('Friday');
      expect(result.recipes).toHaveLength(2);
      expect(result.recipes[0]).toMatchObject({
        id: 'r1',
        name: 'Soup',
        totalTime: 1800,
        url: 'https://cookidoo.ch/recipes/recipe/de-CH/r1',
      });
      expect(result.recipes[0].thumbnail).toContain(
        't_web_shared_recipe_221x240',
      );
      expect(result.recipes[1]).toMatchObject({
        id: 'c1',
        name: 'My dish',
        totalTime: null,
        thumbnail: null,
        image: null,
      });
      expect(result.customerRecipeIds).toEqual(['c1']);
    });

    it('defaults missing recipe collections to empty arrays', () => {
      const result = calendarDayFromJson(
        { id: '2026-06-27', title: 'Saturday', recipes: [] },
        localization,
      );

      expect(result.recipes).toEqual([]);
      expect(result.customerRecipeIds).toEqual([]);
    });
  });

  describe('durationToSeconds', () => {
    it('parses ISO-8601 durations', () => {
      expect(durationToSeconds('PT1H30M')).toBe(5400);
      expect(durationToSeconds('PT45M')).toBe(2700);
      expect(durationToSeconds('PT30S')).toBe(30);
      expect(durationToSeconds('P1DT2H')).toBe(93600);
    });

    it('passes through numbers and numeric strings', () => {
      expect(durationToSeconds(600)).toBe(600);
      expect(durationToSeconds('600')).toBe(600);
    });

    it('defaults to 0 for null/undefined/garbage', () => {
      expect(durationToSeconds(null)).toBe(0);
      expect(durationToSeconds(undefined)).toBe(0);
      expect(durationToSeconds('not a duration')).toBe(0);
    });
  });

  describe('customRecipeFromJson', () => {
    it('maps content, durations, text lists and image', () => {
      const result = customRecipeFromJson(
        {
          recipeId: 'cr1',
          recipeContent: {
            name: 'My cake',
            totalTime: 'PT1H',
            prepTime: 'PT20M',
            image: 'http://img/{transformation}.jpg',
            recipeYield: { value: 6, unitText: 'portions' },
            recipeIngredient: ['200 g flour', { text: '3 eggs' }],
            recipeInstructions: [{ text: 'Mix' }, 'Bake'],
            tool: ['Thermomix'],
          },
        },
        localization,
      );

      expect(result.id).toBe('cr1');
      expect(result.name).toBe('My cake');
      expect(result.totalTime).toBe(3600);
      expect(result.activeTime).toBe(1200);
      expect(result.servingSize).toBe(6);
      expect(result.ingredients).toEqual(['200 g flour', '3 eggs']);
      expect(result.instructions).toEqual(['Mix', 'Bake']);
      expect(result.tools).toEqual(['Thermomix']);
      expect(result.thumbnail).toContain('t_web_shared_recipe_221x240');
      expect(result.url).toBe('https://cookidoo.ch/created-recipes/de-CH/cr1');
    });

    it('falls back to yield/ingredients aliases and null image', () => {
      const result = customRecipeFromJson(
        {
          recipeId: 'cr2',
          recipeContent: {
            name: 'Plain',
            yield: { value: 2 },
            ingredients: ['water'],
            instructions: ['boil'],
          },
        },
        localization,
      );

      expect(result.servingSize).toBe(2);
      expect(result.ingredients).toEqual(['water']);
      expect(result.totalTime).toBe(0);
      expect(result.thumbnail).toBeNull();
      expect(result.image).toBeNull();
    });
  });

  describe('collectionFromJson', () => {
    it('maps id/title/description and nested chapters', () => {
      const result = collectionFromJson({
        id: 'col1',
        title: 'Weeknight dinners',
        description: 'Quick meals',
        chapters: [
          {
            title: 'Pasta',
            recipes: [{ id: 'r1', title: 'Carbonara', totalTime: '1500' }],
          },
        ],
      });

      expect(result).toEqual({
        id: 'col1',
        name: 'Weeknight dinners',
        description: 'Quick meals',
        chapters: [
          {
            name: 'Pasta',
            recipes: [{ id: 'r1', name: 'Carbonara', totalTime: 1500 }],
          },
        ],
      });
    });

    it('defaults missing description and chapters', () => {
      const result = collectionFromJson({ id: 'col2', title: 'Empty' });

      expect(result.description).toBeNull();
      expect(result.chapters).toEqual([]);
    });
  });

  describe('watchlistItemFromJson', () => {
    it('maps a bookmark to a watchlist item', () => {
      const result = watchlistItemFromJson({
        id: 'FAV-1',
        recipe: {
          id: 'r1',
          asciiTitle: 'Pasta',
          landscapeImage: 'http://img/l.jpg',
          prepTime: '900.0',
          locale: 'de-DE',
        },
      });

      expect(result).toEqual({
        bookmarkId: 'FAV-1',
        recipeId: 'r1',
        name: 'Pasta',
        totalTime: 900,
        image: 'http://img/l.jpg',
        locale: 'de-DE',
      });
    });

    it('defaults missing recipe fields to null', () => {
      const result = watchlistItemFromJson({
        id: 'FAV-2',
        recipe: { id: 'r2' },
      });

      expect(result).toEqual({
        bookmarkId: 'FAV-2',
        recipeId: 'r2',
        name: null,
        totalTime: null,
        image: null,
        locale: null,
      });
    });
  });
});
