declare module 'cassandra-driver' {
  interface ClientOptions {
    contactPoints: string[];
    localDataCenter?: string;
    keyspace?: string;
    credentials?: { username: string; password: string };
    protocolOptions?: { port: number };
  }
  interface ResultSet {
    rows: any[];
    columns: { name: string; type: { code: number } }[];
  }
  class Client {
    constructor(options: ClientOptions);
    connect(): Promise<void>;
    execute(query: string, params?: any[], options?: any): Promise<ResultSet>;
    shutdown(): Promise<void>;
    keyspace: string;
  }
  export { Client };
  export default { Client };
}

declare module '@clickhouse/client' {
  interface ClickHouseClientConfig {
    url?: string;
    username?: string;
    password?: string;
    database?: string;
  }
  interface ResultSet {
    json<T = any>(): Promise<T[]>;
    text(): Promise<string>;
  }
  function createClient(config: ClickHouseClientConfig): {
    query(params: { query: string; format?: string; query_params?: Record<string, any> }): Promise<ResultSet>;
    close(): Promise<void>;
    ping(): Promise<{ success: boolean }>;
  };
  export { createClient, ClickHouseClientConfig };
}

declare module 'duckdb' {
  class Database {
    constructor(path: string, callback?: (err: Error | null) => void);
    connect(): Connection;
    close(callback?: (err: Error | null) => void): void;
  }
  class Connection {
    all(sql: string, ...params: any[]): any[];
    all(sql: string, callback: (err: Error | null, rows: any[]) => void): void;
    all(sql: string, params: any[], callback: (err: Error | null, rows: any[]) => void): void;
    run(sql: string, ...params: any[]): void;
    run(sql: string, callback: (err: Error | null) => void): void;
  }
  export { Database, Connection };
  export default { Database, Connection };
}

declare module '@elastic/elasticsearch' {
  interface ClientOptions {
    node?: string;
    auth?: { username: string; password: string };
    tls?: { rejectUnauthorized: boolean };
  }
  class Client {
    constructor(options: ClientOptions);
    ping(): Promise<any>;
    search(params: any): Promise<any>;
    cat: { indices(params?: any): Promise<any> };
    indices: {
      getMapping(params: any): Promise<any>;
      create(params: any): Promise<any>;
      refresh(params: any): Promise<any>;
    };
    close(): Promise<void>;
  }
  export { Client };
}

declare module '@influxdata/influxdb-client' {
  class InfluxDB {
    constructor(options: { url: string; token?: string });
    getQueryApi(org: string): QueryApi;
  }
  interface QueryApi {
    collectRows(query: string): Promise<any[]>;
  }
  export { InfluxDB, QueryApi };
}

declare module 'neo4j-driver' {
  function driver(url: string, auth?: any, config?: any): Driver;
  function isInt(val: any): boolean;
  namespace auth {
    function basic(username: string, password: string): any;
  }
  namespace types {
    class Node { labels: string[]; properties: Record<string, any>; }
    class Relationship { type: string; properties: Record<string, any>; }
    class Path { segments: Array<{ start: Node; relationship: Relationship; end: Node }>; }
  }
  interface Driver {
    session(config?: any): Session;
    close(): Promise<void>;
    verifyConnectivity(): Promise<any>;
  }
  interface Session {
    run(query: string, params?: any): Promise<Result>;
    close(): Promise<void>;
  }
  interface Result {
    records: Record[];
    summary: any;
  }
  interface Record {
    keys: string[];
    get(key: string): any;
    toObject(): any;
  }
  namespace integer {
    function toNumber(val: any): number;
  }
  const Driver: any;
  export default { driver, auth, integer, isInt, types, Driver };
  export { driver, auth, integer, isInt, types, Driver, Session, Result, Record };
}
