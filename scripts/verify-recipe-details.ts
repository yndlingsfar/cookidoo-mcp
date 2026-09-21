/**
 * Verifies the recipe details mapper against a live Cookidoo response.
 *
 * The recipe endpoint answers with JSON without authentication, so this needs
 * no session. Run it after changing the mapper to confirm that the assumptions
 * about the upstream payload still hold.
 *
 * Usage: pnpm verify:recipe [recipeId]
 */
import { CookidooLocalization } from '../src/core/config/cookidoo.config';
import { recipeDetailsFromJson } from '../src/contexts/cookidoo/infrastructure/cookidoo/cookidoo.mappers';

const localization: CookidooLocalization = {
  countryCode: 'de',
  language: 'de-DE',
  url: 'https://cookidoo.de/foundation/de-DE',
};

/** Any surviving HTML tag or entity — not just the ones we already know about. */
const MARKUP = /<[^>]+>|&[a-zA-Z#0-9]+;/;

async function main(): Promise<void> {
  const id = process.argv[2] ?? 'r16687';
  if (!/^r\d+$/.test(id)) {
    console.error(
      `Invalid recipe id "${id}". Expected the form r12345.\n` +
        'Usage: pnpm verify:recipe [recipeId]',
    );
    process.exit(1);
  }
  const url = `https://cookidoo.de/recipes/recipe/de-DE/${id}`;

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }

  const details = recipeDetailsFromJson(await response.json(), localization);
  const kcal = details.nutrition?.values.find((v) => v.type === 'kcal');

  console.log(`recipe:     ${details.name} (${details.id})`);
  console.log(`portions:   ${details.servingSize}`);
  console.log(
    `nutrition:  ${
      details.nutrition
        ? `${kcal?.number ?? '?'} kcal per ${details.nutrition.basisQuantity} ${details.nutrition.basisUnit}`
        : 'none reported'
    }`,
  );
  console.log(`steps:      ${details.steps.length}`);
  if (details.steps.length > 0) {
    console.log(`first step: ${details.steps[0].text}`);
  }
  const withMarkup = details.steps.filter((step) => MARKUP.test(step.text));
  if (withMarkup.length > 0) {
    throw new Error(
      `HTML markup survived in ${withMarkup.length} of ${details.steps.length} steps, e.g.: ${withMarkup[0].text}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
