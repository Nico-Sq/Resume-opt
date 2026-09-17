import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ResumeDocumentV1ShapeSchema } from '@resume/domain/resume';
import { format } from 'prettier';
import { z } from 'zod';

const outputPath = resolve(
  import.meta.dirname,
  '../packages/domain/generated/resume-document-v1.schema.json',
);
const generated = await format(
  JSON.stringify(
    z.toJSONSchema(ResumeDocumentV1ShapeSchema, {
      target: 'draft-2020-12',
      unrepresentable: 'throw',
    }),
  ),
  { parser: 'json', printWidth: 100 },
);

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '');
  if (current !== generated) {
    console.error('Resume JSON Schema 已漂移，请运行 pnpm contracts:generate。');
    process.exitCode = 1;
  }
} else {
  await mkdir(resolve(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, generated, 'utf8');
  console.log(`Generated ${outputPath}`);
}
