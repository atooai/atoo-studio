---
sidebar_position: 5
---

# Database Explorer

Atoo Studio includes a built-in database explorer supporting 15+ database types with auto-discovery and specialized views.

## Supported Databases

| Database | Driver | Specialized View |
|----------|--------|-----------------|
| PostgreSQL | `pg` | Schema browser, query panel |
| MySQL | `mysql2` | Schema browser, query panel |
| SQLite | `better-sqlite3` | Schema browser, query panel |
| Redis | native | Key browser with value inspection |
| MongoDB | `mongodb` | Document viewer with JSON exploration |
| Elasticsearch | native | Document browser |
| OpenSearch | native | Document browser |
| ClickHouse | native | Schema browser, query panel |
| CockroachDB | `pg` | Schema browser, query panel |
| Cassandra | native | Schema browser, query panel |
| ScyllaDB | native | Schema browser, query panel |
| Neo4j | native | Graph visualization |
| InfluxDB | native | Time-series charts |
| Memcached | native | Key-value browser |

## Auto-Discovery

Databases are automatically discovered from:

- **docker-compose files** — parses service definitions for database containers
- **Environment variables** — detects connection strings in `.env` files
- **Local port scanning** — finds databases running on standard ports
- **Container inspection** — reads connection details from running containers

Discovery re-runs when containers start or stop.

## Manual Connections

Add connections manually by providing:

- Database type
- Host, port, and credentials
- Database name or connection string

Credentials are stored with obfuscation.

## Query Execution

For SQL databases, run queries directly in the UI with streaming results. The query panel supports:

- Multi-statement execution
- Result pagination
- Column sorting
- Export results

## Agent Integration

Agents can open the database explorer with a specific connection using the `connect_database` MCP tool.
