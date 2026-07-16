import { validateGameContent } from '../src/content/validate';

const errors = validateGameContent();
if (errors.length) {
  for (const error of errors) console.error(`Content validation: ${error}`);
  process.exitCode = 1;
} else {
  console.log('Game content validation passed.');
}
