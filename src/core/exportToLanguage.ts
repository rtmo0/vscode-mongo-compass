import { EJSON } from 'bson';
import type { Document } from 'mongodb';
import type { QueryState } from './types';
import { redactConnectionString } from './connectionString';

export type ExportLanguage =
  | 'shell'
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'java'
  | 'csharp'
  | 'go'
  | 'php'
  | 'ruby'
  | 'rust'
  | 'compass';

export const EXPORT_LANGUAGES: Array<{ id: ExportLanguage; label: string }> = [
  { id: 'shell', label: 'mongosh' },
  { id: 'javascript', label: 'JavaScript (Node.js)' },
  { id: 'typescript', label: 'TypeScript (Node.js)' },
  { id: 'python', label: 'Python (pymongo)' },
  { id: 'java', label: 'Java (Sync)' },
  { id: 'csharp', label: 'C# (.NET)' },
  { id: 'go', label: 'Go' },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'rust', label: 'Rust' },
  { id: 'compass', label: 'Compass (paste-able)' }
];

export interface ExportInput {
  database: string;
  collection: string;
  query?: QueryState;
  pipeline?: Document[];
  connectionString?: string;
}

/**
 * Hand-rolled equivalent of Compass' `bson-transpilers` /
 * `compass-export-to-language`: turns a query or pipeline into driver code.
 */
export function exportToLanguage(language: ExportLanguage, input: ExportInput): string {
  const isPipeline = Array.isArray(input.pipeline);
  switch (language) {
    case 'shell':
      return toShell(input, isPipeline);
    case 'javascript':
      return toNode(input, isPipeline, false);
    case 'typescript':
      return toNode(input, isPipeline, true);
    case 'python':
      return toPython(input, isPipeline);
    case 'java':
      return toJava(input, isPipeline);
    case 'csharp':
      return toCSharp(input, isPipeline);
    case 'go':
      return toGo(input, isPipeline);
    case 'php':
      return toPhp(input, isPipeline);
    case 'ruby':
      return toRuby(input, isPipeline);
    case 'rust':
      return toRust(input, isPipeline);
    case 'compass':
      return toCompass(input, isPipeline);
    default:
      return toShell(input, isPipeline);
  }
}

// ───────────────────────────── mongosh ─────────────────────────────

function toShell(input: ExportInput, isPipeline: boolean): string {
  const ns = `db.getSiblingDB('${input.database}').getCollection('${input.collection}')`;
  if (isPipeline) {
    return `// MongoDB Shell / mongosh
const pipeline = ${toJs(input.pipeline ?? [], 2)};

const cursor = ${ns}.aggregate(pipeline);
cursor.forEach(doc => printjson(doc));`;
  }
  const q = input.query;
  const args = shellFindArgs(q);
  return `// MongoDB Shell / mongosh
const filter = ${toJs(q?.filter ?? {}, 2)};
const options = ${toJs(args.options, 2)};

const cursor = ${ns}.find(filter, options);
cursor.forEach(doc => printjson(doc));`;
}

function shellFindArgs(q?: QueryState): { options: Document } {
  const options: Document = {};
  if (q) {
    if (q.project && Object.keys(q.project).length) {
      options.projection = q.project;
    }
    if (q.sort && Object.keys(q.sort).length) {
      options.sort = q.sort;
    }
    if (q.skip) {
      options.skip = q.skip;
    }
    if (q.limit) {
      options.limit = q.limit;
    }
    if (q.collation) {
      options.collation = q.collation;
    }
    if (q.maxTimeMS) {
      options.maxTimeMS = q.maxTimeMS;
    }
  }
  return { options };
}

// ───────────────────────────── Node.js ─────────────────────────────

function toNode(input: ExportInput, isPipeline: boolean, typescript: boolean): string {
  const header = typescript
    ? `import { MongoClient, type Document } from 'mongodb';`
    : `const { MongoClient } = require('mongodb');`;
  const uri = input.connectionString ?? 'mongodb://localhost:27017';
  const docType = typescript ? ': Document[]' : '';

  if (isPipeline) {
    return `${header}

const uri = '${redact(uri)}';
const client = new MongoClient(uri);

async function run()${typescript ? ': Promise<Document[]>' : ''} {
  try {
    await client.connect();
    const collection = client.db('${input.database}').collection('${input.collection}');
    const pipeline${typescript ? ': Document[]' : ''} = ${toJs(input.pipeline ?? [], 2)};
    const result${docType} = await collection.aggregate(pipeline).toArray();
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await client.close();
  }
}

run().catch(console.dir);`;
  }

  const { options } = shellFindArgs(input.query);
  return `${header}

const uri = '${redact(uri)}';
const client = new MongoClient(uri);

async function run()${typescript ? ': Promise<Document[]>' : ''} {
  try {
    await client.connect();
    const collection = client.db('${input.database}').collection('${input.collection}');
    const filter${typescript ? ': Document' : ''} = ${toJs(input.query?.filter ?? {}, 2)};
    const options${typescript ? ': Document' : ''} = ${toJs(options, 2)};
    const result${docType} = await collection.find(filter, options).toArray();
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await client.close();
  }
}

run().catch(console.dir);`;
}

// ───────────────────────────── Python ─────────────────────────────

function toPython(input: ExportInput, isPipeline: boolean): string {
  const uri = redact(input.connectionString ?? 'mongodb://localhost:27017');
  if (isPipeline) {
    return `# pip install pymongo
from pymongo import MongoClient

uri = "${uri}"
client = MongoClient(uri)

db = client["${input.database}"]
collection = db["${input.collection}"]

pipeline = ${toPythonValue(input.pipeline ?? [], 0)}

for doc in collection.aggregate(pipeline):
    print(doc)

client.close()`;
  }
  const { options } = shellFindArgs(input.query);
  const pyOptions = toPythonValue(options, 0);
  return `# pip install pymongo
from pymongo import MongoClient

uri = "${uri}"
client = MongoClient(uri)

db = client["${input.database}"]
collection = db["${input.collection}"]

filter = ${toPythonValue(input.query?.filter ?? {}, 0)}
options = ${pyOptions}

for doc in collection.find(filter, **options):
    print(doc)

client.close()`;
}

// ───────────────────────────── Java ─────────────────────────────

function toJava(input: ExportInput, isPipeline: boolean): string {
  const uri = redact(input.connectionString ?? 'mongodb://localhost:27017');
  if (isPipeline) {
    return `// compile 'org.mongodb:mongodb-driver-sync:5.2.0'
import com.mongodb.client.*;
import org.bson.Document;
import java.util.Arrays;
import java.util.List;

public class Aggregation {
    public static void main(String[] args) {
        try (MongoClient mongoClient = MongoClients.create("${uri}")) {
            MongoDatabase database = mongoClient.getDatabase("${input.database}");
            MongoCollection<Document> collection = database.getCollection("${input.collection}");

            List<Document> pipeline = ${toJavaValue(input.pipeline ?? [], 3)};

            AggregateIterable<Document> results = collection.aggregate(pipeline);
            for (Document doc : results) {
                System.out.println(doc.toJson());
            }
        }
    }
}`;
  }
  const { options } = shellFindArgs(input.query);
  return `// compile 'org.mongodb:mongodb-driver-sync:5.2.0'
import com.mongodb.client.*;
import com.mongodb.client.model.Collation;
import org.bson.Document;

public class Query {
    public static void main(String[] args) {
        try (MongoClient mongoClient = MongoClients.create("${uri}")) {
            MongoDatabase database = mongoClient.getDatabase("${input.database}");
            MongoCollection<Document> collection = database.getCollection("${input.collection}");

            Document filter = ${toJavaValue(input.query?.filter ?? {}, 3)};
            FindIterable<Document> results = collection.find(filter)${javaFindOptions(options)};

            for (Document doc : results) {
                System.out.println(doc.toJson());
            }
        }
    }
}`;
}

function javaFindOptions(options: Document): string {
  const parts: string[] = [];
  if (options.projection) {
    parts.push(`.projection(${toJavaValue(options.projection, 3)})`);
  }
  if (options.sort) {
    parts.push(`.sort(${toJavaValue(options.sort, 3)})`);
  }
  if (options.skip !== undefined) {
    parts.push(`.skip(${options.skip})`);
  }
  if (options.limit !== undefined) {
    parts.push(`.limit(${options.limit})`);
  }
  if (options.maxTimeMS !== undefined) {
    parts.push(`.maxTime(${options.maxTimeMS}, java.util.concurrent.TimeUnit.MILLISECONDS)`);
  }
  return parts.join('\n                ');
}

// ───────────────────────────── C# ─────────────────────────────

function toCSharp(input: ExportInput, isPipeline: boolean): string {
  const uri = redact(input.connectionString ?? 'mongodb://localhost:27017');
  if (isPipeline) {
    return `// Install-Package MongoDB.Driver
using MongoDB.Bson;
using MongoDB.Driver;

var client = new MongoClient("${uri}");
var database = client.GetDatabase("${input.database}");
var collection = database.GetCollection<BsonDocument>("${input.collection}");

var pipeline = new BsonArray
${toCSharpValue(input.pipeline ?? [], 0)};

var results = await collection.Aggregate()
    .Pipeline<BsonDocument>(pipeline)
    .ToListAsync();

foreach (var doc in results)
{
    Console.WriteLine(doc.ToString());
}`;
  }
  const { options } = shellFindArgs(input.query);
  return `// Install-Package MongoDB.Driver
using MongoDB.Bson;
using MongoDB.Driver;

var client = new MongoClient("${uri}");
var database = client.GetDatabase("${input.database}");
var collection = database.GetCollection<BsonDocument>("${input.collection}");

var filter = ${toCSharpValue(input.query?.filter ?? {}, 0)};
var findOptions = new FindOptions<BsonDocument>
{
${csharpOptions(options)}
};

var results = await collection.Find(filter, findOptions).ToListAsync();

foreach (var doc in results)
{
    Console.WriteLine(doc.ToString());
}`;
}

function csharpOptions(options: Document): string {
  const lines: string[] = [];
  if (options.projection) {
    lines.push(`    Projection = ${toCSharpValue(options.projection, 0)},`);
  }
  if (options.sort) {
    lines.push(`    Sort = ${toCSharpValue(options.sort, 0)},`);
  }
  if (options.skip !== undefined) {
    lines.push(`    Skip = ${options.skip},`);
  }
  if (options.limit !== undefined) {
    lines.push(`    Limit = ${options.limit},`);
  }
  if (options.maxTimeMS !== undefined) {
    lines.push(`    MaxTime = TimeSpan.FromMilliseconds(${options.maxTimeMS}),`);
  }
  return lines.join('\n') || '    // no options';
}

// ───────────────────────────── Go ─────────────────────────────

function toGo(input: ExportInput, isPipeline: boolean): string {
  const uri = redact(input.connectionString ?? 'mongodb://localhost:27017');
  if (isPipeline) {
    return `// go get go.mongodb.org/mongo-driver/mongo
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI("${uri}"))
	if err != nil {
		log.Fatal(err)
	}
	defer client.Disconnect(ctx)

	collection := client.Database("${input.database}").Collection("${input.collection}")
	pipeline := ${toGoValue(input.pipeline ?? [], 1)}

	cursor, err := collection.Aggregate(ctx, pipeline)
	if err != nil {
		log.Fatal(err)
	}
	defer cursor.Close(ctx)

	var results []bson.M
	if err := cursor.All(ctx, &results); err != nil {
		log.Fatal(err)
	}
	for _, doc := range results {
		fmt.Println(doc)
	}
}`;
  }
  const { options } = shellFindArgs(input.query);
  return `// go get go.mongodb.org/mongo-driver/mongo
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI("${uri}"))
	if err != nil {
		log.Fatal(err)
	}
	defer client.Disconnect(ctx)

	collection := client.Database("${input.database}").Collection("${input.collection}")
	filter := ${toGoValue(input.query?.filter ?? {}, 1)}
	findOptions := ${goFindOptions(options)}

	cursor, err := collection.Find(ctx, filter, findOptions)
	if err != nil {
		log.Fatal(err)
	}
	defer cursor.Close(ctx)

	var results []bson.M
	if err := cursor.All(ctx, &results); err != nil {
		log.Fatal(err)
	}
	for _, doc := range results {
		fmt.Println(doc)
	}
}`;
}

function goFindOptions(options: Document): string {
  const parts: string[] = ['options.Find()'];
  if (options.projection) {
    parts.push(`SetProjection(${toGoValue(options.projection, 1)})`);
  }
  if (options.sort) {
    parts.push(`SetSort(${toGoValue(options.sort, 1)})`);
  }
  if (options.skip !== undefined) {
    parts.push(`SetSkip(int64(${options.skip}))`);
  }
  if (options.limit !== undefined) {
    parts.push(`SetLimit(int64(${options.limit}))`);
  }
  if (options.maxTimeMS !== undefined) {
    parts.push(`SetMaxTime(${options.maxTimeMS} * time.Millisecond)`);
  }
  return parts.join('.\n		');
}

// ───────────────────────────── PHP ─────────────────────────────

function toPhp(input: ExportInput, isPipeline: boolean): string {
  const uri = redact(input.connectionString ?? 'mongodb://localhost:27017');
  if (isPipeline) {
    return `<?php
// composer require mongodb/mongodb
require 'vendor/autoload.php';

$client = new MongoDB\\Client('${uri}');
$collection = $client->selectCollection('${input.database}', '${input.collection}');

$pipeline = ${toPhpValue(input.pipeline ?? [], 0)};

foreach ($collection->aggregate($pipeline) as $document) {
    echo json_encode($document, JSON_PRETTY_PRINT), PHP_EOL;
}`;
  }
  const { options } = shellFindArgs(input.query);
  return `<?php
// composer require mongodb/mongodb
require 'vendor/autoload.php';

$client = new MongoDB\\Client('${uri}');
$collection = $client->selectCollection('${input.database}', '${input.collection}');

$filter = ${toPhpValue(input.query?.filter ?? {}, 0)};
$options = ${toPhpValue(options, 0)};

foreach ($collection->find($filter, $options) as $document) {
    echo json_encode($document, JSON_PRETTY_PRINT), PHP_EOL;
}`;
}

// ───────────────────────────── Ruby ─────────────────────────────

function toRuby(input: ExportInput, isPipeline: boolean): string {
  const uri = redact(input.connectionString ?? 'mongodb://localhost:27017');
  if (isPipeline) {
    return `# gem install mongo
require 'mongo'

client = Mongo::Client.new('${uri}')
collection = client.use('${input.database}').collection('${input.collection}')

pipeline = ${toRubyValue(input.pipeline ?? [], 0)}

collection.aggregate(pipeline).each do |document|
  puts document.to_json
end

client.close`;
  }
  const { options } = shellFindArgs(input.query);
  return `# gem install mongo
require 'mongo'

client = Mongo::Client.new('${uri}')
collection = client.use('${input.database}').collection('${input.collection}')

filter = ${toRubyValue(input.query?.filter ?? {}, 0)}
options = ${toRubyValue(options, 0)}

collection.find(filter, options).each do |document|
  puts document.to_json
end

client.close`;
}

// ───────────────────────────── Rust ─────────────────────────────

function toRust(input: ExportInput, isPipeline: boolean): string {
  const uri = redact(input.connectionString ?? 'mongodb://localhost:27017');
  if (isPipeline) {
    return `// Cargo.toml: mongodb = "3", tokio = { version = "1", features = ["full"] }
use mongodb::{bson::doc, Client, options::ClientOptions};

#[tokio::main]
async fn main() -> mongodb::error::Result<()> {
    let client = Client::with_options(ClientOptions::parse("${uri}").await?)?;
    let collection = client.database("${input.database}").collection::<mongodb::bson::Document>("${input.collection}");

    let pipeline = vec![${toRustValue(input.pipeline ?? [], 1)}];

    let mut cursor = collection.aggregate(pipeline).await?;
    while let Some(doc) = cursor.try_next().await? {
        println!("{}", doc);
    }
    Ok(())
}`;
  }
  const { options } = shellFindArgs(input.query);
  return `// Cargo.toml: mongodb = "3", tokio = { version = "1", features = ["full"] }
use mongodb::{bson::doc, Client, options::{ClientOptions, FindOptions}};

#[tokio::main]
async fn main() -> mongodb::error::Result<()> {
    let client = Client::with_options(ClientOptions::parse("${uri}").await?)?;
    let collection = client.database("${input.database}").collection::<mongodb::bson::Document>("${input.collection}");

    let filter = ${toRustValue(input.query?.filter ?? {}, 1)};
    let options = FindOptions::builder()${rustFindOptions(options)}.build();

    let mut cursor = collection.find(filter).with_options(options).await?;
    while let Some(doc) = cursor.try_next().await? {
        println!("{}", doc);
    }
    Ok(())
}`;
}

function rustFindOptions(options: Document): string {
  const parts: string[] = [];
  if (options.projection) {
    parts.push(`.projection(${toRustValue(options.projection, 1)})`);
  }
  if (options.sort) {
    parts.push(`.sort(${toRustValue(options.sort, 1)})`);
  }
  if (options.skip !== undefined) {
    parts.push(`.skip(${options.skip})`);
  }
  if (options.limit !== undefined) {
    parts.push(`.limit(${options.limit})`);
  }
  return parts.join('');
}

// ───────────────────────────── Compass ─────────────────────────────

function toCompass(input: ExportInput, isPipeline: boolean): string {
  if (isPipeline) {
    return `// Paste into the Compass Aggregation Pipeline Builder
// Namespace: ${input.database}.${input.collection}
${toJs(input.pipeline ?? [], 2)}`;
  }
  return `// Paste into the Compass Query Bar
// Namespace: ${input.database}.${input.collection}
// Filter
${toJs(input.query?.filter ?? {}, 2)}

// Project
${toJs(input.query?.project ?? {}, 2)}

// Sort
${toJs(input.query?.sort ?? {}, 2)}

// Collation
${toJs(input.query?.collation ?? {}, 2)}

// Skip: ${input.query?.skip ?? 0}
// Limit: ${input.query?.limit ?? 0}
// Max Time MS: ${input.query?.maxTimeMS ?? 0}`;
}

// ───────────────────────────── value serialisers ─────────────────────────────

function toJs(value: unknown, indent: number): string {
  return EJSON.stringify(value, undefined, indent, { relaxed: false })
    .replace(/"([A-Za-z_$][\w$]*)"\s*:/g, '$1:')
    .replace(/\{\s*\}/g, '{}');
}

function toPythonValue(value: unknown, depth: number): string {
  const pad = '    '.repeat(depth);
  const innerPad = '    '.repeat(depth + 1);
  if (value === null) {
    return 'None';
  }
  if (value === undefined) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'string') {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  if (value instanceof Date) {
    return `datetime(${value.getUTCFullYear()}, ${value.getUTCMonth() + 1}, ${value.getUTCDate()}, ${value.getUTCHours()}, ${value.getUTCMinutes()}, ${value.getUTCSeconds()})`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    const items = value.map((v) => `${innerPad}${toPythonValue(v, depth + 1)}`).join(',\n');
    return `[\n${items}\n${pad}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Document);
    if (entries.length === 0) {
      return '{}';
    }
    const lines = entries
      .map(([k, v]) => `${innerPad}"${k}": ${toPythonValue(v, depth + 1)}`)
      .join(',\n');
    return `{\n${lines}\n${pad}}`;
  }
  return String(value);
}

function toJavaValue(value: unknown, depth: number): string {
  const pad = ' '.repeat(depth * 4);
  const innerPad = ' '.repeat((depth + 1) * 4);
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `${value}L` : String(value);
  }
  if (typeof value === 'string') {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  if (value instanceof Date) {
    return `new java.util.Date(${value.getTime()}L)`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'Arrays.asList()';
    }
    const items = value.map((v) => `${innerPad}${toJavaValue(v, depth + 1)}`).join(',\n');
    return `Arrays.asList(\n${items}\n${pad})`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Document);
    if (entries.length === 0) {
      return 'new Document()';
    }
    const lines = entries
      .map(([k, v], i) => `${innerPad}${i === 0 ? '' : '.append('}"${k}", ${toJavaValue(v, depth + 1)}${i === 0 ? '' : ')'}`)
      .join('\n');
    return `new Document()\n${lines}`;
  }
  return String(value);
}

function toCSharpValue(value: unknown, depth: number): string {
  const pad = ' '.repeat(depth * 4);
  const innerPad = ' '.repeat((depth + 1) * 4);
  if (value === null || value === undefined) {
    return 'BsonNull.Value';
  }
  if (typeof value === 'boolean') {
    return `new BsonBoolean(${value})`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `new BsonInt64(${value})` : `new BsonDouble(${value})`;
  }
  if (typeof value === 'string') {
    return `new BsonString("${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
  }
  if (value instanceof Date) {
    return `new BsonDateTime(${value.getTime()})`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'new BsonArray()';
    }
    const items = value.map((v) => `${innerPad}${toCSharpValue(v, depth + 1)}`).join(',\n');
    return `new BsonArray\n${pad}{\n${items}\n${pad}}`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Document);
    if (entries.length === 0) {
      return 'new BsonDocument()';
    }
    const lines = entries
      .map(([k, v]) => `${innerPad}{ "${k}", ${toCSharpValue(v, depth + 1)} }`)
      .join(',\n');
    return `new BsonDocument\n${pad}{\n${lines}\n${pad}}`;
  }
  return String(value);
}

function toGoValue(value: unknown, depth: number): string {
  const pad = '\t'.repeat(depth);
  const innerPad = '\t'.repeat(depth + 1);
  if (value === null || value === undefined) {
    return 'nil';
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `int64(${value})` : String(value);
  }
  if (typeof value === 'string') {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  if (value instanceof Date) {
    return `time.Unix(${Math.floor(value.getTime() / 1000)}, 0)`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'bson.A{}';
    }
    const items = value.map((v) => `${innerPad}${toGoValue(v, depth + 1)}`).join(',\n');
    return `bson.A{\n${items},\n${pad}}`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Document);
    if (entries.length === 0) {
      return 'bson.D{}';
    }
    const lines = entries
      .map(([k, v]) => `${innerPad}{Key: "${k}", Value: ${toGoValue(v, depth + 1)}},`)
      .join('\n');
    return `bson.D{\n${lines}\n${pad}}`;
  }
  return String(value);
}

function toPhpValue(value: unknown, depth: number): string {
  const pad = ' '.repeat(depth * 4);
  const innerPad = ' '.repeat((depth + 1) * 4);
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (value instanceof Date) {
    return `new MongoDB\\BSON\\UTCDateTime(new DateTime('${value.toISOString()}'))`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    const items = value.map((v) => `${innerPad}${toPhpValue(v, depth + 1)}`).join(',\n');
    return `[\n${items}\n${pad}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Document);
    if (entries.length === 0) {
      return '[]';
    }
    const lines = entries
      .map(([k, v]) => `${innerPad}'${k}' => ${toPhpValue(v, depth + 1)}`)
      .join(',\n');
    return `[\n${lines}\n${pad}]`;
  }
  return String(value);
}

function toRubyValue(value: unknown, depth: number): string {
  const pad = ' '.repeat(depth * 2);
  const innerPad = ' '.repeat((depth + 1) * 2);
  if (value === null || value === undefined) {
    return 'nil';
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (value instanceof Date) {
    return `Time.utc(${value.getUTCFullYear()}, ${value.getUTCMonth() + 1}, ${value.getUTCDate()}, ${value.getUTCHours()}, ${value.getUTCMinutes()}, ${value.getUTCSeconds()})`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    const items = value.map((v) => `${innerPad}${toRubyValue(v, depth + 1)}`).join(',\n');
    return `[\n${items}\n${pad}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Document);
    if (entries.length === 0) {
      return '{}';
    }
    const lines = entries
      .map(([k, v]) => `${innerPad}'${k}' => ${toRubyValue(v, depth + 1)}`)
      .join(',\n');
    return `{\n${lines}\n${pad}}`;
  }
  return String(value);
}

function toRustValue(value: unknown, depth: number): string {
  const pad = ' '.repeat(depth * 4);
  const innerPad = ' '.repeat((depth + 1) * 4);
  if (value === null || value === undefined) {
    return 'Bson::Null';
  }
  if (typeof value === 'boolean') {
    return `Bson::Boolean(${value})`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `Bson::Int64(${value})` : `Bson::Double(${value})`;
  }
  if (typeof value === 'string') {
    return `Bson::String("${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
  }
  if (value instanceof Date) {
    return `Bson::DateTime(DateTime::from_millis(${value.getTime()}))`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'Bson::Array(vec![])';
    }
    const items = value.map((v) => `${innerPad}${toRustValue(v, depth + 1)}`).join(',\n');
    return `Bson::Array(vec![\n${items}\n${pad}])`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Document);
    if (entries.length === 0) {
      return 'doc! {}';
    }
    const lines = entries
      .map(([k, v]) => `${innerPad}"${k}": ${toRustValue(v, depth + 1)},`)
      .join('\n');
    return `doc! {\n${lines}\n${pad}}`;
  }
  return String(value);
}

function redact(uri: string): string {
  return redactConnectionString(uri);
}
