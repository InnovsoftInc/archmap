// The viewer's model: what `toViewModel` builds from the map docs and the
// browser draws. Collections have no prototype, so an id like "constructor"
// is just a key.

export type Column = {
  name: string;
  type?: string;
  pk?: boolean;
  unique?: boolean;
  fk?: string;
  enum?: string;
  array?: boolean;
  desc?: string;
  [key: string]: unknown;
};

export type Table = {
  area?: string;
  purpose?: string;
  append?: boolean;
  order?: number;
  columns: Column[];
  [key: string]: unknown;
};

export type Service = {
  name?: string;
  lane?: string;
  parent?: string;
  type?: string;
  status?: string;
  [key: string]: unknown;
};

export type Connection = {
  from: string;
  to: string;
  label?: string;
  protocol?: string;
  status?: string;
  [key: string]: unknown;
};

export type Use = { to: string; label?: string };

export type Job = {
  job: string;
  t?: Record<string, string>;
  [key: string]: unknown;
};

export type Persona = {
  name?: string;
  uses?: Use[];
  jobs?: Job[];
  [key: string]: unknown;
};

export type FlowStep = {
  from: string;
  to?: string;
  label?: string;
  status?: string;
};

export type Flow = {
  name?: string;
  steps?: FlowStep[];
  [key: string]: unknown;
};

export type Entity = Record<string, unknown>;

export type Model = {
  flows: Record<string, Flow>;
  categories: Record<string, Entity>;
  areas: Record<string, Entity>;
  tables: Record<string, Table>;
  enums: Record<string, Entity>;
  services: Record<string, Service>;
  connections: Record<string, Connection>;
  personas: Record<string, Persona>;
  problems: string[];
};

const bag = <T>(): Record<string, T> =>
  Object.create(null) as Record<string, T>;

export const emptyModel = (): Model => ({
  flows: bag(),
  categories: bag(),
  areas: bag(),
  tables: bag(),
  enums: bag(),
  services: bag(),
  connections: bag(),
  personas: bag(),
  problems: [],
});
