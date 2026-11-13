import { rename, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';

const indent = (text, columns) => text.replaceAll('\n', `\n${' '.repeat(columns)}`);

export async function* serializeBenchmarkArtifact(artifact) {
  const properties = [];
  for (const key of Object.keys(artifact)) {
    const value = artifact[key];
    if (key === 'results' && Array.isArray(value)) {
      properties.push({ key, results: value });
      continue;
    }
    const serialized = JSON.stringify(value, null, 2);
    if (serialized !== undefined) properties.push({ key, serialized });
  }

  yield '{';
  for (let propertyIndex = 0; propertyIndex < properties.length; propertyIndex++) {
    const property = properties[propertyIndex];
    yield `${propertyIndex ? ',' : ''}\n  ${JSON.stringify(property.key)}: `;
    if (property.results) {
      if (!property.results.length) yield '[]';
      else {
        yield '[';
        for (let index = 0; index < property.results.length; index++) {
          const serialized = JSON.stringify(property.results[index], null, 2) ?? 'null';
          yield `${index ? ',' : ''}\n    ${indent(serialized, 4)}`;
        }
        yield '\n  ]';
      }
    } else {
      yield indent(property.serialized, 2);
    }
  }
  yield properties.length ? '\n}' : '}';
}

export async function writeBenchmarkArtifact(path, artifact) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, serializeBenchmarkArtifact(artifact));
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
