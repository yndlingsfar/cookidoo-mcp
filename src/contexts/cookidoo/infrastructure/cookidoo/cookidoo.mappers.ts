import { CookidooLocalization } from '@core/config/cookidoo.config';
import {
  CookidooSubscription,
  CookidooUserInfo,
} from '../../domain/types/cookidoo-account.type';
import {
  CookidooIngredient,
  CookidooNutrition,
  CookidooNutritionValue,
  CookidooRecipeDetails,
  CookidooRecipeStep,
  CookidooSearchRecipeHit,
  CookidooSearchResult,
  CookidooShoppingRecipe,
} from '../../domain/types/cookidoo-recipe.type';
import {
  CookidooAdditionalItem,
  CookidooIngredientItem,
} from '../../domain/types/cookidoo-shopping-list.type';
import {
  CookidooCalendarDay,
  CookidooCalendarDayRecipe,
} from '../../domain/types/cookidoo-calendar.type';
import { CookidooCustomRecipe } from '../../domain/types/cookidoo-custom-recipe.type';
import {
  CookidooChapter,
  CookidooCollection,
} from '../../domain/types/cookidoo-collection.type';
import { CookidooWatchlistItem } from '../../domain/types/cookidoo-watchlist.type';
import {
  IMAGE_TRANSFORMATION,
  THUMBNAIL_TRANSFORMATION,
} from './cookidoo.constants';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

/** Build a recipe URL on the localized Cookidoo domain. */
export function constructRecipeUrl(
  localization: CookidooLocalization,
  recipeId: string,
  pathPrefix = 'recipes/recipe',
): string {
  const host = new URL(localization.url).host;
  return `https://${host}/${pathPrefix}/${localization.language}/${recipeId}`;
}

/** Replace the `{transformation}` placeholder to get (thumbnail, image) URLs. */
export function processImageUrl(url: string): [string, string] {
  return [
    url.replace('{transformation}', THUMBNAIL_TRANSFORMATION),
    url.replace('{transformation}', IMAGE_TRANSFORMATION),
  ];
}

/** Pick the first usable variant from a list of descriptive assets. */
function extractImages(
  descriptiveAssets: Json[] | undefined,
): [string | null, string | null] {
  if (!Array.isArray(descriptiveAssets)) {
    return [null, null];
  }
  for (const asset of descriptiveAssets) {
    for (const variant of ['square', 'portrait', 'landscape']) {
      const url = asset?.[variant];
      if (url) {
        return processImageUrl(String(url));
      }
    }
  }
  return [null, null];
}

/** Render a quantity object (single value or a from/to range) as text. */
function quantityToString(quantity: Json | undefined | null): string {
  if (!quantity) {
    return '';
  }
  if (quantity.value) {
    return String(quantity.value);
  }
  if (quantity.from && quantity.to) {
    return `${quantity.from} - ${quantity.to}`;
  }
  return '';
}

function ingredientDescription(item: Json): string {
  const quantity = quantityToString(item.quantity);
  if (item.unitNotation && quantity) {
    return `${quantity} ${item.unitNotation}`;
  }
  return quantity;
}

export function ingredientFromJson(item: Json): CookidooIngredient {
  return {
    id: item.localId ?? item.id,
    name: item.ingredientNotation,
    description: ingredientDescription(item),
  };
}

export function ingredientItemFromJson(item: Json): CookidooIngredientItem {
  return {
    id: item.id,
    name: item.ingredientNotation,
    isOwned: Boolean(item.isOwned),
    description: ingredientDescription(item),
  };
}

export function additionalItemFromJson(item: Json): CookidooAdditionalItem {
  return {
    id: item.id,
    name: item.name,
    isOwned: Boolean(item.isOwned),
  };
}

export function userInfoFromJson(profile: Json): CookidooUserInfo {
  const userInfo: Json = profile.userInfo ?? {};
  return {
    id: profile.id,
    username: userInfo.username,
    description: userInfo.description ?? null,
    picture: userInfo.picture ?? null,
  };
}

export function subscriptionFromJson(sub: Json): CookidooSubscription {
  return {
    active: Boolean(sub.active),
    expires: sub.expires,
    startDate: sub.startDate,
    status: sub.status,
    subscriptionLevel: sub.subscriptionLevel,
    subscriptionSource: sub.subscriptionSource,
    type: sub.type,
    extendedType: sub.extendedType,
  };
}

export function shoppingRecipeFromJson(
  recipe: Json,
  localization: CookidooLocalization,
): CookidooShoppingRecipe {
  const [thumbnail, image] = extractImages(recipe.descriptiveAssets);
  const groups: Json[] = recipe.recipeIngredientGroups ?? [];
  return {
    id: recipe.id,
    name: recipe.title,
    ingredients: groups.map(ingredientFromJson),
    thumbnail,
    image,
    url: constructRecipeUrl(localization, recipe.id),
  };
}

function findTime(times: Json[] | undefined, type: string): number | null {
  if (!Array.isArray(times)) {
    return null;
  }
  for (const entry of times) {
    if (entry?.type === type && entry?.quantity?.value) {
      return Number(entry.quantity.value);
    }
  }
  return null;
}

/**
 * Is this a real, finite number?
 *
 * Deliberately not `Number(x)`: coercion turns `''` into 0 and `true` into 1,
 * which would report a fabricated figure as if it had been measured.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Map the individual figures of one nutrition entry, dropping unusable ones. */
function nutritionValuesFromJson(raw: unknown): CookidooNutritionValue[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return (raw as Json[])
    .filter(
      (value) =>
        typeof value?.type === 'string' && isFiniteNumber(value.number),
    )
    .map((value) => ({
      type: value.type,
      number: value.number,
      unit: typeof value.unittype === 'string' ? value.unittype : '',
    }));
}

/**
 * Map one `recipeNutritions` entry, or null when it is not usable.
 *
 * An entry is usable only when it states the basis its figures refer to and
 * carries at least one real figure. An unlabelled basis ("we do not know what
 * these numbers are per") is treated exactly like missing figures: absent.
 * A present but non-numeric `quantity` also makes the entry unusable — the API
 * writes nested `{ value: n }` quantities elsewhere, and defaulting to 1 here
 * would assert "per one unit" without evidence. Only an absent `quantity`
 * defaults to 1.
 */
function nutritionEntryFromJson(entry: Json): CookidooNutrition | null {
  const basisUnit =
    typeof entry?.unitNotation === 'string' ? entry.unitNotation.trim() : '';
  if (basisUnit === '') {
    return null;
  }

  const rawQuantity: unknown = entry?.quantity;
  const missingQuantity = rawQuantity === undefined || rawQuantity === null;
  if (!missingQuantity && !isFiniteNumber(rawQuantity)) {
    return null;
  }
  const basisQuantity = missingQuantity ? 1 : rawQuantity;

  const values = nutritionValuesFromJson(entry?.nutritions);
  if (values.length === 0) {
    return null;
  }
  return { basisQuantity, basisUnit, values };
}

/**
 * Read the nutrition figures from a recipe payload.
 *
 * Cookidoo reports figures against a basis (`1 Portion`, `100 g`, …) that is
 * carried through unchanged: assuming portions here would silently scale every
 * downstream calculation. A recipe may report several bases at once (per
 * portion *and* per whole recipe, a 16x difference) in an order the API does
 * not guarantee, so the labelled entry is selected explicitly and never by
 * position. Returns null when no usable figures are present, which is not the
 * same as zero.
 */
function nutritionFromJson(groups: unknown): CookidooNutrition | null {
  if (!Array.isArray(groups)) {
    return null;
  }
  for (const group of groups as Json[]) {
    const entries: unknown = group?.recipeNutritions;
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries as Json[]) {
      const nutrition = nutritionEntryFromJson(entry);
      if (nutrition !== null) {
        return nutrition;
      }
    }
  }
  return null;
}

/**
 * The HTML 4 Latin-1 entity names in code point order, starting at U+00A0.
 *
 * Cookidoo escapes every non-ASCII character of a step text as a named entity —
 * live payloads carry `&ccedil;`, `&atilde;`, `&Oslash;`, `&deg;` and more — so
 * the whole block is decoded rather than a hand-picked subset that the next
 * recipe would outgrow.
 */
const LATIN1_ENTITY_NAMES: string[] = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg ' +
  'macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo ' +
  'frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig ' +
  'Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve ' +
  'Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN ' +
  'szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc ' +
  'euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml ' +
  'divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
).split(' ');

/**
 * The entities decoded in step texts: the markup ones, the Latin-1 block and
 * the punctuation Cookidoo uses for ranges and quotes.
 *
 * `&nbsp;` (and its siblings) decode to a plain space rather than to U+00A0:
 * this text is read aloud and printed, and a plain space is friendlier for
 * every downstream consumer that splits, trims or searches it. The invisible
 * soft hyphen is dropped for the same reason. Both overrides come after the
 * Latin-1 block so that they win.
 */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ...Object.fromEntries(
    LATIN1_ENTITY_NAMES.map((name, index) => [
      name,
      String.fromCodePoint(0xa0 + index),
    ]),
  ),
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  hellip: '\u2026',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  bull: '\u2022',
  dagger: '\u2020',
  Dagger: '\u2021',
  permil: '\u2030',
  prime: '\u2032',
  Prime: '\u2033',
  euro: '\u20ac',
  trade: '\u2122',
  minus: '\u2212',
  le: '\u2264',
  ge: '\u2265',
  ne: '\u2260',
  frasl: '\u2044',
  larr: '\u2190',
  rarr: '\u2192',
  OElig: '\u0152',
  oelig: '\u0153',
  Scaron: '\u0160',
  scaron: '\u0161',
  Yuml: '\u0178',
  circ: '\u02c6',
  tilde: '\u02dc',
};

/**
 * Decode named and numeric HTML entities.
 *
 * One single pass: the replacement output is never rescanned, so `&amp;lt;`
 * decodes to the literal text `&lt;` instead of being decoded twice into `<`.
 * Unknown entities are left untouched rather than guessed at.
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g,
    (match: string, reference: string) => {
      if (reference.startsWith('#')) {
        const isHex = reference[1] === 'x' || reference[1] === 'X';
        const code = Number.parseInt(
          isHex ? reference.slice(2) : reference.slice(1),
          isHex ? 16 : 10,
        );
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
          return match;
        }
        return String.fromCodePoint(code);
      }
      return HTML_ENTITIES[reference] ?? match;
    },
  );
}

/**
 * Turn a Cookidoo `formattedText` into plain text.
 *
 * Cookidoo wraps parts of a step in markup — `<nobr>` around machine settings,
 * `<strong>` for emphasis, `<p>` for paragraphs — and escapes non-ASCII
 * characters as entities. All of it is presentation: the text is read aloud at
 * the table and printed on a cheat sheet, where a literal `<strong>` is noise
 * and `&eacute;` is simply wrong. Tags are removed before entities are decoded,
 * so an escaped `&lt;strong&gt;` in the content survives as text. Block-level
 * tags become a space so that removing them cannot glue two words together;
 * whitespace runs are then collapsed, which leaves machine settings such as
 * `14 Min./Varoma/Stufe 1` untouched.
 */
function stripHtml(html: string): string {
  const spaced = html
    .replace(/<\s*(br|p|div|li|ul|ol|tr|td|th|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<\s*\/\s*(p|div|li|ul|ol|tr|td|th|h[1-6])\s*>/gi, ' ');
  const withoutTags = spaced.replace(/<[^>]*>/g, '');
  return decodeHtmlEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

/**
 * Flatten the preparation steps of a recipe.
 *
 * Step texts arrive as HTML and leave as plain text; see {@link stripHtml}.
 */
function stepsFromJson(groups: unknown): CookidooRecipeStep[] {
  if (!Array.isArray(groups)) {
    return [];
  }
  return (groups as Json[]).flatMap((group) => {
    const steps: Json[] = Array.isArray(group?.recipeSteps)
      ? group.recipeSteps
      : [];
    const groupTitle =
      typeof group?.title === 'string' && group.title.trim() !== ''
        ? group.title.trim()
        : null;
    return steps
      .filter((step) => typeof step?.formattedText === 'string')
      .map((step) => ({
        group: groupTitle,
        number:
          typeof step.title === 'string' && step.title.trim() !== ''
            ? step.title.trim()
            : null,
        text: stripHtml(step.formattedText),
      }));
  });
}

export function recipeDetailsFromJson(
  recipe: Json,
  localization: CookidooLocalization,
): CookidooRecipeDetails {
  const [thumbnail, image] = extractImages(recipe.descriptiveAssets);
  const groups: Json[] = recipe.recipeIngredientGroups ?? [];
  const ingredients = groups.flatMap((group) =>
    (group.recipeIngredients ?? []).map(ingredientFromJson),
  );
  const notes = (recipe.additionalInformation ?? [])
    .map((info: Json) => info.content)
    .filter(
      (content: unknown): content is string => typeof content === 'string',
    );
  const utensils = (recipe.recipeUtensils ?? [])
    .map((utensil: Json) => utensil.utensilNotation)
    .filter((value: unknown): value is string => typeof value === 'string');

  return {
    id: recipe.id,
    name: recipe.title,
    ingredients,
    difficulty: recipe.difficulty ?? null,
    notes,
    utensils,
    nutrition: nutritionFromJson(recipe.nutritionGroups),
    steps: stepsFromJson(recipe.recipeStepGroups),
    servingSize: recipe.servingSize?.quantity?.value ?? 0,
    activeTime: findTime(recipe.times, 'activeTime'),
    totalTime: findTime(recipe.times, 'totalTime'),
    thumbnail,
    image,
    url: constructRecipeUrl(localization, recipe.id),
  };
}

/** Map a single recipe planned on a calendar day. */
export function calendarDayRecipeFromJson(
  recipe: Json,
  localization: CookidooLocalization,
): CookidooCalendarDayRecipe {
  const images = recipe.assets?.images;
  const [thumbnail, image] = extractImages(images ? [images] : undefined);
  const totalTime =
    recipe.totalTime === undefined || recipe.totalTime === null
      ? null
      : Number(recipe.totalTime);
  return {
    id: recipe.id,
    name: recipe.title,
    totalTime,
    thumbnail,
    image,
    url: constructRecipeUrl(localization, recipe.id),
  };
}

/** Map a single day of the meal-planner calendar, merging custom recipes. */
export function calendarDayFromJson(
  day: Json,
  localization: CookidooLocalization,
): CookidooCalendarDay {
  const recipes: Json[] = day.recipes ?? [];
  const customerRecipes: Json[] = day.customerRecipes ?? [];
  return {
    id: day.id,
    title: day.title,
    recipes: [...recipes, ...customerRecipes].map((recipe) =>
      calendarDayRecipeFromJson(recipe, localization),
    ),
    customerRecipeIds: Array.isArray(day.customerRecipeIds)
      ? day.customerRecipeIds
      : [],
  };
}

/**
 * Convert a duration to whole seconds. Accepts a number (already seconds) or an
 * ISO-8601 duration string such as `PT1H30M`; anything else yields 0.
 */
export function durationToSeconds(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'number') {
    return Math.trunc(value);
  }
  if (typeof value !== 'string') {
    return 0;
  }
  const match =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value.trim(),
    );
  if (!match) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
  }
  const [, days, hours, minutes, seconds] = match;
  return Math.trunc(
    (Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 +
      Number(minutes ?? 0) * 60 +
      Number(seconds ?? 0),
  );
}

/** Normalise a recipe-content list whose entries may be strings or `{text}`. */
function extractTextList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) =>
      typeof item === 'string' ? item : ((item as Json)?.text ?? null),
    )
    .filter((text): text is string => typeof text === 'string');
}

export function customRecipeFromJson(
  recipe: Json,
  localization: CookidooLocalization,
): CookidooCustomRecipe {
  const content: Json = recipe.recipeContent ?? {};
  let thumbnail: string | null = null;
  let image: string | null = null;
  if (content.image) {
    [thumbnail, image] = processImageUrl(String(content.image));
  }
  const recipeYield: Json = content.recipeYield ??
    content.yield ?? { value: 0, unitText: '' };

  return {
    id: recipe.recipeId,
    name: content.name,
    ingredients: extractTextList(
      content.recipeIngredient ?? content.ingredients,
    ),
    instructions: extractTextList(
      content.recipeInstructions ?? content.instructions,
    ),
    servingSize: recipeYield.value ?? 0,
    totalTime: durationToSeconds(content.totalTime),
    activeTime: durationToSeconds(content.prepTime),
    tools: extractTextList(content.tool ?? content.tools),
    thumbnail,
    image,
    url: constructRecipeUrl(localization, recipe.recipeId, 'created-recipes'),
  };
}

export function collectionFromJson(collection: Json): CookidooCollection {
  const chapters: Json[] = collection.chapters ?? [];
  return {
    id: collection.id,
    name: collection.title,
    description: collection.description ?? null,
    chapters: chapters.map((chapter): CookidooChapter => ({
      name: chapter.title,
      recipes: (chapter.recipes ?? []).map((recipe: Json) => ({
        id: recipe.id,
        name: recipe.title,
        totalTime: Math.trunc(Number(recipe.totalTime ?? 0)),
      })),
    })),
  };
}

export function watchlistItemFromJson(bookmark: Json): CookidooWatchlistItem {
  const recipe: Json = bookmark.recipe ?? {};
  const prep = recipe.prepTime;
  return {
    bookmarkId: bookmark.id ?? '',
    recipeId: recipe.id ?? '',
    name: recipe.asciiTitle ?? null,
    totalTime:
      prep === undefined || prep === null ? null : Math.trunc(Number(prep)),
    image: recipe.landscapeImage ?? null,
    locale: recipe.locale ?? null,
  };
}

export function searchResultFromJson(
  data: Json,
  localization: CookidooLocalization,
): CookidooSearchResult {
  const rawRecipes: Json[] = data.data ?? data.recipes ?? [];
  const recipes: CookidooSearchRecipeHit[] = [];
  for (const item of rawRecipes) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const id = item.id ?? '';
    const [thumbnail, image] = extractImages(item.descriptiveAssets);
    recipes.push({
      id,
      name: item.title ?? item.name ?? '',
      thumbnail,
      image,
      url: constructRecipeUrl(localization, id),
    });
  }
  const total = typeof data.total === 'number' ? data.total : recipes.length;
  return { recipes, total };
}
