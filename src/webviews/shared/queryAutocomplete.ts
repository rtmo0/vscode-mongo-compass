import { el, clear } from './client';

/**
 * Autocomplete for the query bar inputs (filter / project / sort) and the
 * aggregation pipeline editor.
 *
 * The text before the caret is scanned to work out *where* the caret is:
 * a key or a value, and inside which object (document root, a field's
 * operator object, `$and` array element, a pipeline stage, an expression, …).
 * Suggestions are then drawn from the sampled field paths plus a catalogue
 * of stages, operators, shell constructors and literal values relevant to
 * that position.
 */

export type QueryInputKind = 'filter' | 'project' | 'sort' | 'pipeline';

export interface FieldInfo {
  path: string;
  types: string[];
  /** For arrays: types of their scalar elements. */
  elementTypes?: string[];
}

/** Shape of the `schemaFields` / `stageFields` responses. */
export interface FieldPathSample {
  fields?: string[];
  fieldTypes?: Record<string, string[]>;
  elementTypes?: Record<string, string[]>;
}

export function toFieldInfo(sample: FieldPathSample): FieldInfo[] {
  return (sample.fields ?? []).map((path) => ({
    path,
    types: sample.fieldTypes?.[path] ?? [],
    elementTypes: sample.elementTypes?.[path]
  }));
}

export interface QueryAutocompleteOptions {
  kind: QueryInputKind;
  /**
   * Field paths available at the caret. Return cached fields synchronously
   * when possible; a returned promise refreshes the open list once resolved.
   */
  fields: (text: string, caret: number) => FieldInfo[] | Promise<FieldInfo[]>;
  /**
   * Virtual text placed before the input's value when analysing the caret,
   * e.g. `[{ $group: ` for an editor that holds only a stage's body.
   */
  contextPrefix?: () => string;
}

type SuggestionKind = 'field' | 'operator' | 'value';

export interface Suggestion {
  label: string;
  detail: string;
  kind: SuggestionKind;
  /** Text to insert; `|` marks the caret, `\n` continues at the line's indentation. */
  insert: string;
  /**
   * A catch-all entry not specific to the position or the field's type. Lists
   * opened automatically (right after a completion) leave these out.
   */
  generic?: boolean;
  /** Replace from this offset instead of the start of the typed word. */
  replaceFrom?: number;
  /** Indent continuation lines like the line containing this offset. */
  indentFrom?: number;
}

interface Frame {
  type: '{' | '[';
  /** Key whose value this container is (`null` at the root). */
  key: string | null;
  /** The last key written inside this object (for `{`). */
  currentKey: string | null;
  /** Offset of the opening bracket in the text. */
  start: number;
}

interface CaretContext {
  position: 'key' | 'value';
  /** Partial word being typed, without a leading quote. */
  token: string;
  /** Start of the replaced range (includes a leading quote, if any). */
  replaceStart: number;
  /** Start of the whitespace / comma run right before `replaceStart`. */
  separatorStart: number;
  quote: string;
  stack: Frame[];
  /** The input has no enclosing braces yet: wrap the insertion in `{ }`. */
  wrap: boolean;
  /** The caret sits inside an unterminated string literal. */
  inString: boolean;
}

// ───────────────────────────── catalogues ─────────────────────────────

const op = (label: string, detail: string, insert = `${label}: |`): Suggestion => ({
  label,
  detail,
  kind: 'operator',
  insert
});

const value = (label: string, detail: string, insert = label): Suggestion => ({
  label,
  detail,
  kind: 'value',
  insert
});

const key = (label: string, detail: string, insert = `${label}: |`): Suggestion => ({
  label,
  detail,
  kind: 'field',
  insert
});

const ROOT_FILTER_OPERATORS: Suggestion[] = [
  op('$and', 'All conditions must match', '$and: [{ | }]'),
  op('$or', 'Any condition must match', '$or: [{ | }]'),
  op('$nor', 'No condition may match', '$nor: [{ | }]'),
  op('$expr', 'Aggregation expression', '$expr: { | }'),
  op('$text', 'Full-text search', '$text: { $search: "|" }'),
  op('$where', 'JavaScript predicate', '$where: "|"'),
  op('$jsonSchema', 'Match a JSON Schema', '$jsonSchema: { | }'),
  op('$comment', 'Attach a comment', '$comment: "|"')
];

const FIELD_OPERATORS: Suggestion[] = [
  op('$eq', 'Equal to'),
  op('$ne', 'Not equal to'),
  op('$gt', 'Greater than'),
  op('$gte', 'Greater than or equal'),
  op('$lt', 'Less than'),
  op('$lte', 'Less than or equal'),
  op('$in', 'Matches any value in array', '$in: [|]'),
  op('$nin', 'Matches no value in array', '$nin: [|]'),
  op('$exists', 'Field is present', '$exists: true|'),
  op('$type', 'Field has BSON type', '$type: "|"'),
  op('$regex', 'Matches a regular expression', '$regex: /|/'),
  op('$options', 'Regex options', '$options: "|"'),
  op('$not', 'Negates an operator expression', '$not: { | }'),
  op('$elemMatch', 'Array element matches all conditions', '$elemMatch: { | }'),
  op('$all', 'Array contains all values', '$all: [|]'),
  op('$size', 'Array has length'),
  op('$mod', 'Divisor and remainder', '$mod: [|, 0]'),
  op('$bitsAllSet', 'All bit positions set'),
  op('$bitsAnySet', 'Any bit position set'),
  op('$bitsAllClear', 'All bit positions clear'),
  op('$bitsAnyClear', 'Any bit position clear'),
  op('$geoWithin', 'Within a geometry', '$geoWithin: { $geometry: | }'),
  op('$geoIntersects', 'Intersects a geometry', '$geoIntersects: { $geometry: | }'),
  op('$near', 'Near a point', '$near: { $geometry: { type: "Point", coordinates: [|] } }'),
  op('$nearSphere', 'Near a point on a sphere', '$nearSphere: { $geometry: { type: "Point", coordinates: [|] } }')
];

const TEXT_OPERATORS: Suggestion[] = [
  op('$search', 'Search string', '$search: "|"'),
  op('$language', 'Text index language', '$language: "|"'),
  op('$caseSensitive', 'Case-sensitive search', '$caseSensitive: true|'),
  op('$diacriticSensitive', 'Diacritic-sensitive search', '$diacriticSensitive: true|')
];

const PROJECTION_OPERATORS: Suggestion[] = [
  op('$slice', 'Limit array elements'),
  op('$elemMatch', 'First matching array element', '$elemMatch: { | }'),
  op('$meta', 'Text search metadata', '$meta: "textScore"|')
];

const FILTER_VALUES: Suggestion[] = ([
  value('ObjectId', 'ObjectId("…")', 'ObjectId("|")'),
  value('ISODate', 'ISODate("…")', 'ISODate("|")'),
  value('NumberLong', 'Int64', 'NumberLong(|)'),
  value('NumberInt', 'Int32', 'NumberInt(|)'),
  value('NumberDecimal', 'Decimal128', 'NumberDecimal("|")'),
  value('UUID', 'UUID("…")', 'UUID("|")'),
  value('RegExp', 'Regular expression', '/|/'),
  value('true', 'Boolean'),
  value('false', 'Boolean'),
  value('null', 'Null or missing')
] as Suggestion[]).map((item) => ({ ...item, generic: true }));

const NUMERIC_TYPES = new Set(['Int32', 'Int64', 'Double', 'Decimal128']);

/** A literal of the given BSON type, used as an operand (`$gt: |`, `$in: [|]`). */
function scalarValuesFor(types: Iterable<string>): Suggestion[] {
  const out: Suggestion[] = [];
  for (const type of types) {
    switch (type) {
      case 'String':
        out.push(value('"…"', 'String', '"|"'));
        break;
      case 'Date':
        out.push(value('ISODate', 'Date', 'ISODate("|")'));
        break;
      case 'ObjectId':
        out.push(value('ObjectId', 'ObjectId', 'ObjectId("|")'));
        break;
      case 'Int64':
        out.push(value('NumberLong', 'Int64', 'NumberLong(|)'));
        break;
      case 'Decimal128':
        out.push(value('NumberDecimal', 'Decimal128', 'NumberDecimal("|")'));
        break;
      case 'UUID':
        out.push(value('UUID', 'UUID', 'UUID("|")'));
        break;
      case 'Boolean':
        out.push(value('true', 'Boolean'), value('false', 'Boolean'));
        break;
      case 'Null':
        out.push(value('null', 'Null'));
        break;
    }
  }
  return out;
}

/** What to write right after `field: ` in a filter, based on the field's sampled types. */
function typedFilterValues(field: FieldInfo): Suggestion[] {
  const out: Suggestion[] = [];
  for (const type of field.types) {
    if (type === 'String') {
      out.push(
        value('"…"', 'String · exact match', '"|"'),
        value('/regex/', 'String · regular expression', '/|/'),
        value('$regex', 'String · case-insensitive', '{ $regex: /|/, $options: "i" }'),
        value('$in', 'String · any of', '{ $in: ["|"] }'),
        value('$ne', 'String · not equal', '{ $ne: "|" }')
      );
    } else if (NUMERIC_TYPES.has(type)) {
      const literal = scalarValuesFor([type]).map((item) => ({ ...item, detail: `${type} · exact match` }));
      out.push(
        ...literal,
        value('$gt', `${type} · greater than`, '{ $gt: | }'),
        value('$gte', `${type} · greater or equal`, '{ $gte: | }'),
        value('$lt', `${type} · less than`, '{ $lt: | }'),
        value('$lte', `${type} · less or equal`, '{ $lte: | }'),
        value('range', `${type} · from … to`, '{ $gte: |, $lt:  }'),
        value('$in', `${type} · any of`, '{ $in: [|] }')
      );
    } else if (type === 'Date') {
      out.push(
        value('ISODate', 'Date · exact match', 'ISODate("|")'),
        value('$gte', 'Date · on or after', '{ $gte: ISODate("|") }'),
        value('$lt', 'Date · before', '{ $lt: ISODate("|") }'),
        value('range', 'Date · from … to', '{ $gte: ISODate("|"), $lt: ISODate("") }')
      );
    } else if (type === 'ObjectId') {
      out.push(
        value('ObjectId', 'ObjectId · exact match', 'ObjectId("|")'),
        value('$in', 'ObjectId · any of', '{ $in: [ObjectId("|")] }')
      );
    } else if (type === 'Boolean') {
      out.push(value('true', 'Boolean'), value('false', 'Boolean'));
    } else if (type === 'UUID') {
      out.push(value('UUID', 'UUID · exact match', 'UUID("|")'));
    } else if (type === 'Array') {
      out.push(
        ...scalarValuesFor(field.elementTypes ?? []).map((item) => ({
          ...item,
          detail: `Array · has element (${item.detail})`
        })),
        value('$elemMatch', 'Array · element matches', '{ $elemMatch: { | } }'),
        value('$all', 'Array · contains all', '{ $all: [|] }'),
        value('$in', 'Array · contains any', '{ $in: [|] }'),
        value('$size', 'Array · has length', '{ $size: | }'),
        value('not empty', 'Array · has elements', '{ $exists: true, $ne: [] }|')
      );
    } else if (type === 'Document') {
      out.push(value('{ }', 'Document · exact match', '{ | }'));
    } else if (type === 'Null') {
      out.push(value('null', 'Null or missing'));
    }
  }
  if (field.types.length > 0) {
    out.push(value('$exists', 'Field is present', '{ $exists: true }|'));
  }
  return dedupe(out);
}

function dedupe(items: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = `${item.label}\u0000${item.insert}`;
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

/** Values for `field: |` in a find projection. */
function projectionValues(field: FieldInfo | undefined): Suggestion[] {
  const out = [value('1', 'Include field'), value('0', 'Exclude field')];
  if (field?.types.includes('Array')) {
    out.push(
      value('$slice', 'Array · first N elements', '{ $slice: | }'),
      value('$elemMatch', 'Array · first matching element', '{ $elemMatch: { | } }')
    );
  }
  out.push({ ...value('$meta', 'Text search score', '{ $meta: "textScore" }|'), generic: true });
  return out;
}

const SORT_VALUES: Suggestion[] = [
  value('1', 'Ascending'),
  value('-1', 'Descending'),
  { ...value('$meta', 'Text search score', '{ $meta: "textScore" }|'), generic: true }
];

const BOOLEAN_VALUES: Suggestion[] = [value('true', 'Boolean'), value('false', 'Boolean')];

const BSON_TYPE_ALIASES = [
  'double', 'string', 'object', 'array', 'binData', 'objectId', 'bool', 'date', 'null',
  'regex', 'javascript', 'int', 'timestamp', 'long', 'decimal', 'number', 'minKey', 'maxKey'
];

const REGEX_OPTIONS: Suggestion[] = [
  value('"i"', 'Case-insensitive'),
  value('"m"', 'Multiline anchors'),
  value('"s"', 'Dot matches newlines'),
  value('"x"', 'Ignore whitespace')
];

/** Field types (as reported by the schema sample) → preferred value constructor. */
const TYPE_TO_VALUE: Record<string, string> = {
  ObjectId: 'ObjectId',
  Date: 'ISODate',
  Int64: 'NumberLong',
  Int32: 'NumberInt',
  Decimal128: 'NumberDecimal',
  UUID: 'UUID',
  Boolean: 'true'
};

/** Pipeline stages; `insert` is the stage key and its value (no outer braces). */
const STAGES: Suggestion[] = [
  op('$match', 'Filter documents', '$match: {\n  |\n}'),
  op('$project', 'Select or compute fields', '$project: {\n  |\n}'),
  op('$addFields', 'Add computed fields', '$addFields: {\n  |\n}'),
  op('$set', 'Add computed fields (alias of $addFields)', '$set: {\n  |\n}'),
  op('$unset', 'Remove fields', '$unset: ["|"]'),
  op('$group', 'Group documents by a key', '$group: {\n  _id: "$|",\n  count: { $sum: 1 }\n}'),
  op('$sort', 'Sort documents', '$sort: {\n  |\n}'),
  op('$limit', 'Limit result count', '$limit: |'),
  op('$skip', 'Skip documents', '$skip: |'),
  op('$unwind', 'One document per array element', '$unwind: "$|"'),
  op('$lookup', 'Join another collection', '$lookup: {\n  from: "|",\n  localField: "",\n  foreignField: "",\n  as: ""\n}'),
  op('$graphLookup', 'Recursive lookup', '$graphLookup: {\n  from: "|",\n  startWith: "$",\n  connectFromField: "",\n  connectToField: "",\n  as: ""\n}'),
  op('$facet', 'Run multiple sub-pipelines', '$facet: {\n  |: []\n}'),
  op('$bucket', 'Group into explicit buckets', '$bucket: {\n  groupBy: "$|",\n  boundaries: [],\n  default: "Other"\n}'),
  op('$bucketAuto', 'Group into evenly sized buckets', '$bucketAuto: {\n  groupBy: "$|",\n  buckets: 5\n}'),
  op('$count', 'Count documents', '$count: "|"'),
  op('$sortByCount', 'Group and count by value', '$sortByCount: "$|"'),
  op('$replaceRoot', 'Replace the root document', '$replaceRoot: { newRoot: "$|" }'),
  op('$replaceWith', 'Replace the root document', '$replaceWith: "$|"'),
  op('$sample', 'Random sample', '$sample: { size: | }'),
  op('$unionWith', 'Append another collection', '$unionWith: { coll: "|", pipeline: [] }'),
  op('$setWindowFields', 'Window functions', '$setWindowFields: {\n  partitionBy: "$|",\n  sortBy: {},\n  output: {}\n}'),
  op('$densify', 'Fill gaps in a sequence', '$densify: { field: "|", range: { step: 1, bounds: "full" } }'),
  op('$fill', 'Fill missing values', '$fill: { output: { |: { method: "linear" } } }'),
  op('$redact', 'Restrict content by expression', '$redact: { | }'),
  op('$geoNear', 'Sort by distance (first stage)', '$geoNear: {\n  near: { type: "Point", coordinates: [|] },\n  distanceField: "distance"\n}'),
  op('$search', 'Atlas Search (first stage)', '$search: {\n  index: "default",\n  text: { query: "|", path: "" }\n}'),
  op('$searchMeta', 'Atlas Search metadata', '$searchMeta: { | }'),
  op('$vectorSearch', 'Atlas Vector Search (first stage)', '$vectorSearch: {\n  index: "|",\n  path: "",\n  queryVector: [],\n  numCandidates: 100,\n  limit: 10\n}'),
  op('$indexStats', 'Index usage statistics', '$indexStats: {}|'),
  op('$collStats', 'Collection statistics', '$collStats: { storageStats: {} }|'),
  op('$out', 'Write results to a collection', '$out: "|"'),
  op('$merge', 'Merge results into a collection', '$merge: { into: "|" }')
];

export interface StageTemplate {
  name: string;
  detail: string;
  /** Starter body: the stage value written after `$name: `. */
  body: string;
}

/** Starter bodies for stages whose snippet leaves the value empty. */
const STAGE_BODY_DEFAULTS: Record<string, string> = {
  $limit: '10',
  $skip: '0',
  $count: '"count"',
  $sample: '{ size: 10 }',
  $facet: '{\n  results: []\n}',
  $fill: '{ output: { field: { method: "linear" } } }'
};

/** The stage catalogue shared by autocomplete and the visual pipeline builder. */
export function stageTemplates(): StageTemplate[] {
  return STAGES.map((stage) => ({
    name: stage.label,
    detail: stage.detail,
    body:
      STAGE_BODY_DEFAULTS[stage.label] ??
      stage.insert.slice(stage.label.length + 2).replace('|', '').replace(/\{\n  \n\}/, '{}')
  }));
}

/** Keys accepted inside object-valued stages. */
const STAGE_KEYS: Record<string, Suggestion[]> = {
  $lookup: [
    key('from', 'Collection to join', 'from: "|"'),
    key('localField', 'Field in the input documents', 'localField: "|"'),
    key('foreignField', 'Field in the "from" collection', 'foreignField: "|"'),
    key('as', 'Output array field', 'as: "|"'),
    key('let', 'Variables for the sub-pipeline', 'let: { | }'),
    key('pipeline', 'Sub-pipeline on the joined collection', 'pipeline: [|]')
  ],
  $graphLookup: [
    key('from', 'Collection to search', 'from: "|"'),
    key('startWith', 'Expression to start from', 'startWith: "$|"'),
    key('connectFromField', 'Field to recurse from', 'connectFromField: "|"'),
    key('connectToField', 'Field to match against', 'connectToField: "|"'),
    key('as', 'Output array field', 'as: "|"'),
    key('maxDepth', 'Maximum recursion depth'),
    key('depthField', 'Field holding the depth', 'depthField: "|"'),
    key('restrictSearchWithMatch', 'Filter for the search', 'restrictSearchWithMatch: { | }')
  ],
  $unwind: [
    key('path', 'Array field to unwind', 'path: "$|"'),
    key('includeArrayIndex', 'Field holding the element index', 'includeArrayIndex: "|"'),
    key('preserveNullAndEmptyArrays', 'Keep documents without elements', 'preserveNullAndEmptyArrays: true|')
  ],
  $replaceRoot: [key('newRoot', 'Document to promote', 'newRoot: "$|"')],
  $sample: [key('size', 'Number of documents')],
  $bucket: [
    key('groupBy', 'Expression to bucket by', 'groupBy: "$|"'),
    key('boundaries', 'Bucket boundaries', 'boundaries: [|]'),
    key('default', 'Bucket for values outside boundaries', 'default: "|"'),
    key('output', 'Accumulated output fields', 'output: { | }')
  ],
  $bucketAuto: [
    key('groupBy', 'Expression to bucket by', 'groupBy: "$|"'),
    key('buckets', 'Number of buckets'),
    key('output', 'Accumulated output fields', 'output: { | }'),
    key('granularity', 'Preferred number series', 'granularity: "|"')
  ],
  $unionWith: [
    key('coll', 'Collection to append', 'coll: "|"'),
    key('pipeline', 'Pipeline on that collection', 'pipeline: [|]')
  ],
  $merge: [
    key('into', 'Target collection', 'into: "|"'),
    key('on', 'Field(s) identifying documents', 'on: "|"'),
    key('whenMatched', 'replace | keepExisting | merge | fail | pipeline', 'whenMatched: "|"'),
    key('whenNotMatched', 'insert | discard | fail', 'whenNotMatched: "|"')
  ],
  $setWindowFields: [
    key('partitionBy', 'Partition expression', 'partitionBy: "$|"'),
    key('sortBy', 'Sort within partitions', 'sortBy: { | }'),
    key('output', 'Window output fields', 'output: { | }')
  ],
  $geoNear: [
    key('near', 'Point to measure from', 'near: { type: "Point", coordinates: [|] }'),
    key('distanceField', 'Output distance field', 'distanceField: "|"'),
    key('maxDistance', 'Maximum distance (meters)'),
    key('minDistance', 'Minimum distance (meters)'),
    key('query', 'Additional filter', 'query: { | }'),
    key('spherical', 'Spherical geometry', 'spherical: true|'),
    key('key', 'Geospatial index field', 'key: "|"')
  ]
};

/** Stage keys whose string value is a plain field name (not a `$field` reference). */
const FIELD_NAME_KEYS = new Set(['localField', 'foreignField', 'connectFromField', 'connectToField', 'field']);

const ACCUMULATORS: Suggestion[] = [
  op('$sum', 'Sum (use 1 to count)', '$sum: |'),
  op('$avg', 'Average', '$avg: "$|"'),
  op('$min', 'Minimum', '$min: "$|"'),
  op('$max', 'Maximum', '$max: "$|"'),
  op('$first', 'First value in group', '$first: "$|"'),
  op('$last', 'Last value in group', '$last: "$|"'),
  op('$push', 'Array of all values', '$push: "$|"'),
  op('$addToSet', 'Array of unique values', '$addToSet: "$|"'),
  op('$count', 'Number of documents', '$count: {}|'),
  op('$mergeObjects', 'Merge documents', '$mergeObjects: "$|"'),
  op('$stdDevPop', 'Population standard deviation', '$stdDevPop: "$|"'),
  op('$stdDevSamp', 'Sample standard deviation', '$stdDevSamp: "$|"'),
  op('$top', 'Top element by sort', '$top: { sortBy: { | }, output: "$" }'),
  op('$bottom', 'Bottom element by sort', '$bottom: { sortBy: { | }, output: "$" }'),
  op('$topN', 'Top N elements by sort', '$topN: { n: |, sortBy: {}, output: "$" }'),
  op('$firstN', 'First N values', '$firstN: { n: |, input: "$" }'),
  op('$lastN', 'Last N values', '$lastN: { n: |, input: "$" }'),
  op('$maxN', 'N largest values', '$maxN: { n: |, input: "$" }'),
  op('$minN', 'N smallest values', '$minN: { n: |, input: "$" }')
];

const EXPRESSION_OPERATORS: Suggestion[] = [
  op('$eq', 'Values are equal', '$eq: ["$|", ]'),
  op('$ne', 'Values differ', '$ne: ["$|", ]'),
  op('$gt', 'First is greater', '$gt: ["$|", ]'),
  op('$gte', 'First is greater or equal', '$gte: ["$|", ]'),
  op('$lt', 'First is less', '$lt: ["$|", ]'),
  op('$lte', 'First is less or equal', '$lte: ["$|", ]'),
  op('$and', 'All expressions true', '$and: [|]'),
  op('$or', 'Any expression true', '$or: [|]'),
  op('$not', 'Negate an expression', '$not: [|]'),
  op('$in', 'Value is in array', '$in: ["$|", []]'),
  op('$cond', 'If / then / else', '$cond: { if: |, then: , else:  }'),
  op('$ifNull', 'First non-null value', '$ifNull: ["$|", ]'),
  op('$switch', 'Multi-branch condition', '$switch: { branches: [{ case: |, then:  }], default:  }'),
  op('$add', 'Add numbers or dates', '$add: ["$|", ]'),
  op('$subtract', 'Subtract', '$subtract: ["$|", ]'),
  op('$multiply', 'Multiply', '$multiply: ["$|", ]'),
  op('$divide', 'Divide', '$divide: ["$|", ]'),
  op('$mod', 'Remainder', '$mod: ["$|", ]'),
  op('$abs', 'Absolute value', '$abs: "$|"'),
  op('$round', 'Round to a place', '$round: ["$|", 0]'),
  op('$floor', 'Round down', '$floor: "$|"'),
  op('$ceil', 'Round up', '$ceil: "$|"'),
  op('$concat', 'Concatenate strings', '$concat: ["$|", ]'),
  op('$substrCP', 'Substring', '$substrCP: ["$|", 0, 1]'),
  op('$toLower', 'Lower-case string', '$toLower: "$|"'),
  op('$toUpper', 'Upper-case string', '$toUpper: "$|"'),
  op('$trim', 'Trim whitespace', '$trim: { input: "$|" }'),
  op('$split', 'Split a string', '$split: ["$|", ""]'),
  op('$strLenCP', 'String length', '$strLenCP: "$|"'),
  op('$regexMatch', 'String matches regex', '$regexMatch: { input: "$|", regex: // }'),
  op('$dateToString', 'Format a date', '$dateToString: { format: "%Y-%m-%d", date: "$|" }'),
  op('$dateFromString', 'Parse a date', '$dateFromString: { dateString: "$|" }'),
  op('$dateTrunc', 'Truncate a date', '$dateTrunc: { date: "$|", unit: "day" }'),
  op('$dateDiff', 'Difference between dates', '$dateDiff: { startDate: "$|", endDate: "$", unit: "day" }'),
  op('$dateAdd', 'Add to a date', '$dateAdd: { startDate: "$|", unit: "day", amount: 1 }'),
  op('$year', 'Year of a date', '$year: "$|"'),
  op('$month', 'Month of a date', '$month: "$|"'),
  op('$dayOfMonth', 'Day of month', '$dayOfMonth: "$|"'),
  op('$hour', 'Hour of a date', '$hour: "$|"'),
  op('$size', 'Array length', '$size: "$|"'),
  op('$arrayElemAt', 'Element at index', '$arrayElemAt: ["$|", 0]'),
  op('$first', 'First array element', '$first: "$|"'),
  op('$last', 'Last array element', '$last: "$|"'),
  op('$slice', 'Sub-array', '$slice: ["$|", 1]'),
  op('$filter', 'Filter array elements', '$filter: { input: "$|", as: "item", cond: {} }'),
  op('$map', 'Transform array elements', '$map: { input: "$|", as: "item", in: {} }'),
  op('$reduce', 'Fold an array', '$reduce: { input: "$|", initialValue: 0, in: {} }'),
  op('$concatArrays', 'Concatenate arrays', '$concatArrays: ["$|", ]'),
  op('$setUnion', 'Union of arrays', '$setUnion: ["$|", ]'),
  op('$mergeObjects', 'Merge documents', '$mergeObjects: ["$|", ]'),
  op('$objectToArray', 'Document to k/v array', '$objectToArray: "$|"'),
  op('$arrayToObject', 'k/v array to document', '$arrayToObject: "$|"'),
  op('$toString', 'Convert to string', '$toString: "$|"'),
  op('$toInt', 'Convert to Int32', '$toInt: "$|"'),
  op('$toDouble', 'Convert to Double', '$toDouble: "$|"'),
  op('$toDate', 'Convert to Date', '$toDate: "$|"'),
  op('$toObjectId', 'Convert to ObjectId', '$toObjectId: "$|"'),
  op('$type', 'BSON type name', '$type: "$|"'),
  op('$literal', 'Value without parsing', '$literal: |'),
  op('$let', 'Define variables', '$let: { vars: { | }, in: {} }'),
  op('$sum', 'Sum of values', '$sum: "$|"'),
  op('$avg', 'Average of values', '$avg: "$|"'),
  op('$min', 'Minimum of values', '$min: "$|"'),
  op('$max', 'Maximum of values', '$max: "$|"')
];

const SYSTEM_VARIABLES: Suggestion[] = [
  value('$$ROOT', 'The whole input document'),
  value('$$CURRENT', 'The current document'),
  value('$$NOW', 'Current date and time'),
  value('$$REMOVE', 'Remove the field')
];

// ───────────────────────────── caret analysis ─────────────────────────────

/** Work out what is being typed at `caret` in `text`. Exported for tests. */
export function analyzeCaret(text: string, caret: number): CaretContext {
  const before = text.slice(0, caret);
  const tokenMatch = /(["']?)(-?[\w$.]*)$/.exec(before)!;
  const quote = tokenMatch[1];
  const token = tokenMatch[2];
  const replaceStart = before.length - tokenMatch[0].length;

  const stack: Frame[] = [];
  let lastWord: string | null = null;
  let last: '{' | '[' | ',' | ':' | 'word' | '' = '';
  let inString = false;
  const scanned = before.slice(0, replaceStart);

  for (let i = 0; i < scanned.length; i += 1) {
    const ch = scanned[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let content = '';
      while (j < scanned.length && scanned[j] !== ch) {
        if (scanned[j] === '\\') {
          j += 1;
        }
        content += scanned[j] ?? '';
        j += 1;
      }
      inString = j >= scanned.length;
      lastWord = content;
      last = 'word';
      i = j;
      continue;
    }
    if (ch === '/' && scanned[i + 1] === '/') {
      // Line comment: skip to the end of the line.
      const end = scanned.indexOf('\n', i);
      i = end < 0 ? scanned.length : end;
      continue;
    }
    if (/[\w$.]/.test(ch)) {
      let j = i;
      while (j < scanned.length && /[\w$.]/.test(scanned[j])) {
        j += 1;
      }
      lastWord = scanned.slice(i, j);
      last = 'word';
      i = j - 1;
      continue;
    }
    const top = stack[stack.length - 1];
    switch (ch) {
      case '{':
      case '[': {
        let frameKey: string | null = null;
        if (last === ':' && top?.type === '{') {
          frameKey = top.currentKey;
        } else if (top?.type === '[') {
          frameKey = top.key;
        }
        stack.push({ type: ch, key: frameKey, currentKey: null, start: i });
        last = ch;
        break;
      }
      case '}':
      case ']':
        stack.pop();
        last = 'word';
        break;
      case ':':
        if (top?.type === '{') {
          top.currentKey = lastWord;
        }
        last = ':';
        break;
      case ',':
        last = ',';
        break;
      default:
        if (!/\s/.test(ch)) {
          last = 'word';
        }
    }
  }

  const top = stack[stack.length - 1];
  let position: CaretContext['position'];
  if (!top) {
    position = 'key';
  } else if (top.type === '[') {
    position = 'value';
  } else {
    position = last === ':' ? 'value' : 'key';
  }

  return {
    position,
    token,
    replaceStart,
    separatorStart: replaceStart - /\s*,?\s*$/.exec(scanned)![0].length,
    quote,
    stack,
    wrap: stack.length === 0 && scanned.trim() === '',
    inString
  };
}

/**
 * For a pipeline `[ {…}, {…}, … ]`, the text of the stages before the stage
 * containing `caret`, closed as an array (e.g. `[ {$match: …} ]`), plus the
 * stage index. `null` when the caret is not inside a top-level stage.
 */
export function pipelineStagePrefix(text: string, caret: number): { stageIndex: number; prefixText: string } | null {
  let depth = 0;
  let stageIndex = -1;
  let stageStart = -1;
  for (let i = 0; i < caret && i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        j += text[j] === '\\' ? 2 : 1;
      }
      i = j;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth === 2 && ch === '{') {
        stageIndex += 1;
        stageStart = i;
      }
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    }
  }
  if (depth < 2 || stageStart < 0) {
    return null;
  }
  const before = text.slice(0, stageStart).replace(/[\s,]*$/, '');
  return { stageIndex, prefixText: `${before}\n]` };
}

// ───────────────────────────── suggestion building ─────────────────────────────

const LOGICAL_ARRAY_KEYS = new Set(['$and', '$or', '$nor']);

function fieldSuggestions(fields: FieldInfo[], basePath = ''): Suggestion[] {
  const out: Suggestion[] = [];
  for (const field of fields) {
    let path = field.path;
    if (basePath) {
      if (!path.startsWith(`${basePath}.`)) {
        continue;
      }
      path = path.slice(basePath.length + 1);
    }
    out.push({
      label: path,
      detail: field.types.join(' | '),
      kind: 'field',
      insert: `${quoteKey(path)}: |`
    });
  }
  return out;
}

/** `"$path"` field references for expressions, plus `$$ROOT` & co. */
function fieldReferences(fields: FieldInfo[], quote: string): Suggestion[] {
  const q = quote || '"';
  return [
    ...fields.map((field) => ({
      label: `$${field.path}`,
      detail: field.types.join(' | '),
      kind: 'field' as const,
      insert: `${q}$${field.path}${q}|`
    })),
    ...SYSTEM_VARIABLES.map((item) => ({ ...item, insert: `${q}${item.label}${q}|` }))
  ];
}

/** Plain field names as string values (`localField: "name"`). */
function fieldNameStrings(fields: FieldInfo[], quote: string): Suggestion[] {
  const q = quote || '"';
  return fields.map((field) => ({
    label: field.path,
    detail: field.types.join(' | '),
    kind: 'field' as const,
    insert: `${q}${field.path}${q}|`
  }));
}

function quoteKey(path: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(path) ? path : `"${path}"`;
}

/** The field path an `$elemMatch` object applies to, e.g. `items` in `{ items: { $elemMatch: { … } } }`. */
function elemMatchBase(stack: Frame[]): string {
  const operatorObject = stack[stack.length - 2];
  return operatorObject?.key && !operatorObject.key.startsWith('$') ? operatorObject.key : '';
}

function isArrayElement(stack: Frame[]): boolean {
  return stack[stack.length - 2]?.type === '[';
}

/** The key whose value the caret is typing (an object's current key, or the array's key). */
function valueKey(stack: Frame[]): string | null {
  const top = stack[stack.length - 1];
  return top?.type === '{' ? top.currentKey : top?.key ?? null;
}

function filterKeySuggestions(stack: Frame[], fields: FieldInfo[]): Suggestion[] {
  const top = stack[stack.length - 1];
  const isDocumentLevel =
    !top || top.key === null || (LOGICAL_ARRAY_KEYS.has(top.key) && isArrayElement(stack));
  if (isDocumentLevel) {
    return [...fieldSuggestions(fields), ...ROOT_FILTER_OPERATORS];
  }
  if (stack.some((frame) => frame.key === '$expr')) {
    return EXPRESSION_OPERATORS;
  }
  switch (top.key) {
    case '$elemMatch':
      return [...fieldSuggestions(fields, elemMatchBase(stack)), ...FIELD_OPERATORS];
    case '$text':
      return TEXT_OPERATORS;
    default:
      return FIELD_OPERATORS;
  }
}

function filterValueSuggestions(context: CaretContext, stack: Frame[], fields: FieldInfo[]): Suggestion[] {
  if (stack.some((frame) => frame.key === '$expr' || frame.currentKey === '$expr')) {
    return expressionValueSuggestions(context, fields);
  }
  switch (valueKey(stack)) {
    case '$exists':
      return BOOLEAN_VALUES;
    case '$type':
      return BSON_TYPE_ALIASES.map((alias) => value(`"${alias}"`, 'BSON type alias'));
    case '$options':
      return REGEX_OPTIONS;
    case '$and':
    case '$or':
    case '$nor':
      return context.quote ? [] : [value('{ }', 'Condition document', '{ | }')];
  }
  if (context.quote) {
    return [];
  }

  const field = fieldAt(stack, fields);
  const operator = valueKey(stack);
  let typed: Suggestion[] = [];
  if (field && (operator === null || !operator.startsWith('$'))) {
    // `{ field: | }`: literals and operator snippets for the field's type.
    typed = typedFilterValues(field);
  } else if (field && operator && !['$size', '$mod', '$exists', '$type', '$regex'].includes(operator)) {
    // `{ field: { $gt: | } }` / `$in: [|]`: literals of the field's (element) type.
    const arrayOperand = field.types.includes('Array') && ['$in', '$nin', '$all', '$eq', '$ne'].includes(operator);
    typed = scalarValuesFor(arrayOperand ? field.elementTypes ?? [] : field.types);
  }

  // Put the generic constructors matching the field's sampled types first.
  const preferred = new Set((field?.types ?? []).map((type) => TYPE_TO_VALUE[type]).filter(Boolean));
  return dedupe([
    ...typed,
    ...FILTER_VALUES.filter((item) => preferred.has(item.label)),
    ...FILTER_VALUES.filter((item) => !preferred.has(item.label))
  ]);
}

/** The sampled field the caret's value belongs to (relative names inside `$elemMatch` resolve by suffix). */
function fieldAt(stack: Frame[], fields: FieldInfo[]): FieldInfo | undefined {
  const path = fieldPathAt(stack);
  if (!path) {
    return undefined;
  }
  return fields.find((field) => field.path === path) ?? fields.find((field) => field.path.endsWith(`.${path}`));
}

/** Values inside an aggregation expression: `"$field"` references when a `$` is typed. */
function expressionValueSuggestions(context: CaretContext, fields: FieldInfo[]): Suggestion[] {
  return context.token.startsWith('$') ? fieldReferences(fields, context.quote) : [];
}

/** The nearest enclosing key that names a field (skips operator keys). */
function fieldPathAt(stack: Frame[]): string | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const frame = stack[i];
    const candidates = i === stack.length - 1 ? [frame.currentKey, frame.key] : [frame.key];
    for (const candidate of candidates) {
      if (candidate && !candidate.startsWith('$')) {
        return candidate;
      }
    }
  }
  return null;
}

/** Suggestions for a query document whose root object is `stack[0]`. */
function querySuggestions(
  kind: Exclude<QueryInputKind, 'pipeline'>,
  context: CaretContext,
  stack: Frame[],
  fields: FieldInfo[]
): Suggestion[] {
  const atRoot = stack.length <= 1;
  if (kind === 'filter') {
    return context.position === 'key'
      ? filterKeySuggestions(stack, fields)
      : filterValueSuggestions(context, stack, fields);
  }
  if (context.position === 'value' && context.quote) {
    return [];
  }
  if (kind === 'project') {
    if (context.position === 'key') {
      return atRoot ? fieldSuggestions(fields) : PROJECTION_OPERATORS;
    }
    return atRoot ? projectionValues(fieldAt(stack, fields)) : [];
  }
  if (context.position === 'key') {
    return atRoot ? [...fieldSuggestions(fields), op('$natural', 'Natural (storage) order', '$natural: 1|')] : [];
  }
  return atRoot ? SORT_VALUES : [];
}

/** Whether `stack[index]` is an array of pipeline stages (root, `pipeline: […]`, or a `$facet` branch). */
function isPipelineArray(stack: Frame[], index: number): boolean {
  const frame = stack[index];
  if (frame.type !== '[') {
    return false;
  }
  return index === 0 || frame.key === 'pipeline' || stack[index - 1]?.key === '$facet';
}

/** Re-root `frames` so the first one behaves as a document root (key `null`). */
function reroot(frames: Frame[]): Frame[] {
  return frames.length ? [{ ...frames[0], key: null }, ...frames.slice(1)] : frames;
}

function pipelineSuggestions(context: CaretContext, fields: FieldInfo[]): Suggestion[] {
  const { stack } = context;
  let pipelineIndex = -1;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (isPipelineArray(stack, i)) {
      pipelineIndex = i;
      break;
    }
  }
  if (pipelineIndex < 0) {
    return [];
  }
  const rel = stack.slice(pipelineIndex);

  // Directly in the stage array: `[ {| ` is handled below; `[ |` offers whole stages.
  if (rel.length === 1) {
    if (context.quote) {
      return [];
    }
    return STAGES.map((stage) => ({ ...stage, insert: `{\n  ${stage.insert.replace(/\n/g, '\n  ')}\n}` }));
  }

  const stageName = rel[1].currentKey ?? '';
  // Stage object itself: stage names as keys; scalar stage values (`$unwind: "$…"`).
  if (rel.length === 2) {
    if (context.position === 'key') {
      if (context.quote) {
        return [];
      }
      // `{ $match: {…}, $pro|`: a stage holds exactly one operator, so close
      // this stage and start the next one instead of adding a second key.
      return stageName ? STAGES.map((stage) => nextStage(stage, context, rel[1].start)) : STAGES;
    }
    if (stageName === '$count' || stageName === '$out' || stageName === '$limit' || stageName === '$skip') {
      return [];
    }
    return expressionValueSuggestions(context, fields);
  }

  const inner = reroot(rel.slice(2));
  switch (stageName) {
    case '$match':
      return querySuggestions('filter', context, inner, fields);
    case '$sort':
      return querySuggestions('sort', context, inner, fields);
    case '$project':
    case '$addFields':
    case '$set':
    case '$group':
      return computedFieldSuggestions(stageName, context, inner, fields);
    case '$unset':
      return context.quote ? fieldNameStrings(fields, context.quote) : [];
    default:
      return stageOptionSuggestions(stageName, context, inner, fields);
  }
}

/** Turn a stage suggestion into one that starts a new stage after the current one. */
function nextStage(stage: Suggestion, context: CaretContext, stageStart: number): Suggestion {
  return {
    ...stage,
    detail: `New stage · ${stage.detail}`,
    insert: `\n}, {\n  ${stage.insert.replace(/\n/g, '\n  ')}`,
    replaceFrom: context.separatorStart,
    indentFrom: stageStart
  };
}

/** `$project` / `$addFields` / `$set` / `$group`: output field names and expressions. */
function computedFieldSuggestions(
  stageName: string,
  context: CaretContext,
  inner: Frame[],
  fields: FieldInfo[]
): Suggestion[] {
  const atRoot = inner.length === 1;
  if (context.position === 'key') {
    if (context.quote) {
      return atRoot && stageName !== '$group' ? fieldSuggestions(fields) : [];
    }
    if (atRoot) {
      if (stageName === '$group') {
        return [key('_id', 'Group key', '_id: "$|"')];
      }
      return fieldSuggestions(fields);
    }
    // `{ total: { $s| } }` in $group → accumulators; elsewhere → expression operators.
    return stageName === '$group' && inner.length === 2 ? ACCUMULATORS : EXPRESSION_OPERATORS;
  }

  if (context.quote || context.token.startsWith('$')) {
    return expressionValueSuggestions(context, fields);
  }
  if (!atRoot) {
    return [];
  }
  const current = inner[0].currentKey;
  if (stageName === '$group') {
    return current === '_id'
      ? [value('null', 'Single group for all documents'), value('{ }', 'Compound group key', '{ | }')]
      : ACCUMULATORS.map((item) => ({ ...item, kind: 'value' as const, insert: `{ ${item.insert} }` }));
  }
  const expressionStarters = [
    value('"$…"', 'Value of another field', '"$|"'),
    value('{ $… }', 'Expression operator', '{ $| }')
  ];
  if (stageName === '$project') {
    return [...projectionValues(fieldAt(inner, fields)).filter((item) => !item.generic), ...expressionStarters];
  }
  return expressionStarters;
}

/** Object-valued stages with a fixed set of options (`$lookup`, `$unwind`, …). */
function stageOptionSuggestions(
  stageName: string,
  context: CaretContext,
  inner: Frame[],
  fields: FieldInfo[]
): Suggestion[] {
  const atRoot = inner.length === 1;
  if (context.position === 'key') {
    if (atRoot) {
      return context.quote ? [] : STAGE_KEYS[stageName] ?? [];
    }
    return context.token.startsWith('$') ? EXPRESSION_OPERATORS : [];
  }
  const current = valueKey(inner);
  if (atRoot && current && FIELD_NAME_KEYS.has(current)) {
    return context.quote ? fieldNameStrings(fields, context.quote) : [];
  }
  if (current === 'preserveNullAndEmptyArrays' || current === 'spherical') {
    return BOOLEAN_VALUES;
  }
  return expressionValueSuggestions(context, fields);
}

function buildSuggestions(kind: QueryInputKind, context: CaretContext, fields: FieldInfo[]): Suggestion[] {
  if (context.inString) {
    return [];
  }
  if (kind === 'pipeline') {
    return pipelineSuggestions(context, fields);
  }
  return querySuggestions(kind, context, context.stack, fields);
}

/**
 * Rank by prefix match, then (fields only) substring match. A match on the
 * last segment of a dotted path counts as a prefix match.
 */
function rank(suggestions: Suggestion[], token: string, limit = 12): Suggestion[] {
  const needle = token.toLowerCase();
  if (!needle) {
    return suggestions.slice(0, limit);
  }
  const bareNeedle = needle.replace(/^\$+/, '');
  const prefix: Suggestion[] = [];
  const partial: Suggestion[] = [];
  for (const item of suggestions) {
    const label = item.label.toLowerCase();
    const lastSegment = label.slice(label.lastIndexOf('.') + 1);
    if (label === needle && item.kind !== 'field') {
      continue;
    }
    if (label.startsWith(needle) || (bareNeedle && lastSegment.startsWith(bareNeedle) && label.includes('.'))) {
      prefix.push(item);
    } else if (item.kind === 'field' && bareNeedle.length >= 2 && label.includes(bareNeedle)) {
      partial.push(item);
    }
  }
  return [...prefix, ...partial].slice(0, limit);
}

/** Ranked suggestions for `text` with the caret at `caret`. Exported for tests. */
export function suggestionsAt(
  kind: QueryInputKind,
  text: string,
  caret: number,
  fields: FieldInfo[],
  auto = false
): Suggestion[] {
  const context = analyzeCaret(text, caret);
  const suggestions = buildSuggestions(kind, context, fields);
  return rank(auto ? suggestions.filter((item) => !item.generic) : suggestions, context.token);
}

// ───────────────────────────── UI ─────────────────────────────

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

const MIRRORED_STYLES = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight',
  'fontStyle', 'letterSpacing', 'lineHeight', 'tabSize', 'textTransform', 'wordSpacing', 'textIndent',
  'whiteSpace', 'wordWrap', 'overflowWrap', 'wordBreak'
] as const;

/** Viewport coordinates of the character at `index` (bottom-left of its line box). */
function caretCoordinates(input: EditableElement, index: number): { left: number; top: number } {
  const style = getComputedStyle(input);
  const mirror = document.createElement('div');
  for (const prop of MIRRORED_STYLES) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.overflow = 'hidden';
  if (input instanceof HTMLInputElement) {
    mirror.style.whiteSpace = 'pre';
  }
  mirror.textContent = input.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.append(marker);
  document.body.append(mirror);
  const rect = input.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const left = rect.left + marker.offsetLeft - input.scrollLeft;
  const top = input instanceof HTMLInputElement
    ? rect.bottom
    : rect.top + marker.offsetTop - input.scrollTop + lineHeight;
  mirror.remove();
  return {
    left: Math.max(rect.left, Math.min(left, rect.right - 40)),
    top: Math.min(Math.max(top, rect.top), rect.bottom)
  };
}

/** Leading whitespace of the line containing `index`. */
function lineIndent(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** Attach autocomplete to `input`; returns a function that removes it again. */
export function attachQueryAutocomplete(input: EditableElement, options: QueryAutocompleteOptions): () => void {
  // A union-typed element loses the per-event overloads of addEventListener.
  const target = input as HTMLElement;
  const list = el('div', { className: 'mc-autocomplete' });
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  document.body.append(list);

  const multiline = input instanceof HTMLTextAreaElement;
  let lastFields: FieldInfo[] = [];
  let visible: Suggestion[] = [];
  let selected = 0;
  let context: CaretContext | null = null;
  /** The open list was shown automatically after a completion. */
  let autoOpened = false;

  const hide = (): void => {
    autoOpened = false;
    list.hidden = true;
    visible = [];
    context = null;
    clear(list);
  };

  const fieldsAtCaret = (): FieldInfo[] => {
    const caret = input.selectionStart ?? input.value.length;
    const result = options.fields(input.value, caret);
    if (Array.isArray(result)) {
      lastFields = result;
      return result;
    }
    void result
      .then((loaded) => {
        lastFields = loaded;
        if (!list.hidden && document.activeElement === input) {
          show(false, autoOpened);
        }
      })
      .catch(() => undefined);
    return lastFields;
  };

  const render = (): void => {
    clear(list);
    visible.forEach((item, index) => {
      const option = el('div', {
        className: `mc-autocomplete-item kind-${item.kind}${index === selected ? ' active' : ''}`
      });
      option.setAttribute('role', 'option');
      option.append(
        el('span', { className: 'mc-autocomplete-icon', text: item.kind === 'field' ? '◆' : item.kind === 'operator' ? '$' : '·' }),
        el('span', { className: 'mc-autocomplete-label', text: item.label }),
        el('span', { className: 'mc-autocomplete-detail', text: item.detail })
      );
      option.addEventListener('mousedown', (event) => {
        event.preventDefault();
        accept(index);
      });
      list.append(option);
    });
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  const position = (): void => {
    if (!context) {
      return;
    }
    const coords = caretCoordinates(input, context.replaceStart);
    list.style.left = `${coords.left}px`;
    list.style.top = `${coords.top + 2}px`;
  };

  /**
   * `force`: opened with Ctrl+Space, show everything that fits.
   * `auto`: opened right after a completion, show only position/type-specific entries.
   */
  /** Analyse the caret, honouring `contextPrefix`; offsets are relative to the input's value. */
  const analyze = (caret: number): CaretContext => {
    const prefix = options.contextPrefix?.() ?? '';
    const result = analyzeCaret(prefix + input.value, prefix.length + caret);
    if (!prefix) {
      return result;
    }
    const shift = (offset: number): number => Math.max(0, offset - prefix.length);
    return {
      ...result,
      replaceStart: shift(result.replaceStart),
      separatorStart: shift(result.separatorStart),
      stack: result.stack.map((frame) => ({ ...frame, start: shift(frame.start) })),
      wrap: false
    };
  };

  const show = (force: boolean, auto = false): void => {
    const caret = input.selectionStart ?? input.value.length;
    if (caret !== input.selectionEnd) {
      hide();
      return;
    }
    const next = analyze(caret);
    const justTyped = input.value.slice(0, caret).trimEnd().slice(-1);
    const typedStructure =
      (next.position === 'key' && (justTyped === '{' || justTyped === ',')) ||
      (options.kind === 'pipeline' && next.stack.length === 1 && (justTyped === '[' || justTyped === ','));
    const enumValue = next.position === 'value' && ['$exists', '$type', '$options'].includes(valueKey(next.stack) ?? '');
    if (!force && !auto && !next.token && !next.quote && !typedStructure && !enumValue) {
      hide();
      return;
    }
    const suggestions = buildSuggestions(options.kind, next, fieldsAtCaret());
    visible = rank(auto ? suggestions.filter((item) => !item.generic) : suggestions, next.token);
    if (visible.length === 0) {
      hide();
      return;
    }
    context = next;
    autoOpened = auto;
    selected = 0;
    render();
    position();
    list.hidden = false;
  };

  const accept = (index: number): void => {
    const item = visible[index];
    if (!item || !context) {
      return;
    }
    const caret = input.selectionStart ?? input.value.length;
    const after = input.value.slice(caret);
    let insert = item.insert;
    let end = caret;
    if (item.kind === 'field' && context.position === 'key' && context.quote && insert.startsWith(`${quoteKey(item.label)}:`)) {
      // Keep the quote style the user started the key with.
      insert = `${context.quote}${item.label}${context.quote}${insert.slice(quoteKey(item.label).length)}`;
    }
    const start = item.replaceFrom ?? context.replaceStart;
    // Editing an existing key: replace the whole key and keep its colon and value.
    const restOfKey = /^[\w$.]*["']?/.exec(after)?.[0] ?? '';
    if (item.replaceFrom === undefined && context.position === 'key' && /^\s*:/.test(after.slice(restOfKey.length))) {
      insert = insert.slice(0, insert.indexOf(':')).replace(/\|/g, '');
      end = caret + restOfKey.length;
    } else if (context.quote) {
      // Completing inside quotes: swallow the rest of the word and an auto-closed quote.
      const restOfWord = /^[\w$.]*/.exec(after)?.[0] ?? '';
      end = caret + restOfWord.length;
      if (after.slice(restOfWord.length).startsWith(context.quote) && /["']\|?$/.test(insert)) {
        end += 1;
      }
    }
    if (context.wrap && after.trim() === '' && options.kind !== 'pipeline') {
      insert = `{ ${insert} }`;
    }
    if (multiline) {
      insert = insert.replace(/\n/g, `\n${lineIndent(input.value, item.indentFrom ?? context.replaceStart)}`);
    } else {
      insert = insert.replace(/\n\s*/g, ' ');
    }
    const caretOffset = insert.indexOf('|');
    const text = insert.replace('|', '');
    input.setRangeText(text, start, end, 'end');
    const caretPosition = start + (caretOffset >= 0 ? caretOffset : text.length);
    input.setSelectionRange(caretPosition, caretPosition);
    input.dispatchEvent(new Event('input'));
    hide();
    input.focus();
    // The snippet left a hole to fill (`field: |`, `{ $match: { | } }`, `"$|"`):
    // continue with suggestions for it straight away.
    const leavesHole = caretOffset >= 0 && (caretOffset < text.length || /:\s$/.test(text));
    if (leavesHole) {
      show(false, true);
    }
  };

  // Warm the field cache so the first suggestions already include fields.
  input.addEventListener('focus', () => void fieldsAtCaret());

  input.addEventListener('input', (event) => {
    // Our own insertions dispatch a plain Event; only react to real typing.
    if (event instanceof InputEvent) {
      show(false);
    }
  });

  // Capture phase so Enter/Tab are handled before the editor's own
  // listeners (e.g. "Enter runs Find") while the list is open.
  target.addEventListener(
    'keydown',
    (event) => {
      if ((event.ctrlKey || event.metaKey) && event.code === 'Space') {
        event.preventDefault();
        show(true);
        return;
      }
      if (list.hidden) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        hide();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
          hide();
        }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'ArrowDown') {
        selected = (selected + 1) % visible.length;
        render();
      } else if (event.key === 'ArrowUp') {
        selected = (selected - 1 + visible.length) % visible.length;
        render();
      } else if (event.key === 'Escape') {
        hide();
      } else {
        accept(selected);
      }
    },
    true
  );

  input.addEventListener('blur', hide);
  input.addEventListener('mousedown', hide);
  const onScroll = (event: Event): void => {
    // The editor scrolling itself (e.g. while typing) only moves the list.
    if (event.target === input) {
      position();
    } else {
      hide();
    }
  };
  window.addEventListener('resize', hide);
  document.addEventListener('scroll', onScroll, true);
  return () => {
    window.removeEventListener('resize', hide);
    document.removeEventListener('scroll', onScroll, true);
    list.remove();
  };
}
