#!/usr/bin/env python3
"""
Scan Claude Code JSONL session files to derive the SessionEvent superset schema.

Usage:
    python3 scripts/scan-session-schema.py [--dir ~/.claude/projects] [--output docs/schema-report.json]

Outputs a JSON report with the complete field inventory per event type,
including content block shapes and nested object structures.
"""

import json
import os
import sys
import argparse
from collections import defaultdict
from pathlib import Path


def classify_value(v):
    """Classify a Python value into a type string."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "number"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "list"
    if isinstance(v, dict):
        return "dict"
    return type(v).__name__


def scan_fields(obj, field_registry, prefix=""):
    """Recursively scan an object and record field names + value types."""
    if not isinstance(obj, dict):
        return
    for key, value in obj.items():
        full_key = f"{prefix}{key}" if prefix else key
        field_registry[full_key].add(classify_value(value))
        if isinstance(value, dict):
            scan_fields(value, field_registry, f"{full_key}.")


def scan_content_blocks(content, block_registry):
    """Scan message.content arrays for content block shapes."""
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type", "unknown")
        for key, value in block.items():
            block_registry[block_type][key].add(classify_value(value))


def main():
    parser = argparse.ArgumentParser(description="Scan Claude JSONL session files for schema derivation")
    parser.add_argument("--dir", default=os.path.expanduser("~/.claude/projects"),
                        help="Directory to scan for .jsonl files (recursive)")
    parser.add_argument("--output", default=None,
                        help="Output JSON report path (default: stdout)")
    parser.add_argument("--max-files", type=int, default=0,
                        help="Max files to scan (0 = unlimited)")
    args = parser.parse_args()

    scan_dir = Path(args.dir)
    if not scan_dir.exists():
        print(f"Error: directory not found: {scan_dir}", file=sys.stderr)
        sys.exit(1)

    # Collect all .jsonl files
    jsonl_files = sorted(scan_dir.rglob("*.jsonl"))
    if args.max_files > 0:
        jsonl_files = jsonl_files[:args.max_files]

    print(f"Scanning {len(jsonl_files)} JSONL files in {scan_dir}...", file=sys.stderr)

    # Per event type: field name -> set of observed value types
    event_fields = defaultdict(lambda: defaultdict(set))
    # Per event type: count
    event_counts = defaultdict(int)
    # Content block types: block_type -> field -> set of value types
    content_blocks = defaultdict(lambda: defaultdict(set))
    # toolUseResult variants
    tool_result_variants = defaultdict(lambda: defaultdict(set))

    total_events = 0
    errors = 0

    for fpath in jsonl_files:
        try:
            with open(fpath, "r") as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        errors += 1
                        continue

                    if not isinstance(event, dict):
                        continue

                    total_events += 1
                    event_type = event.get("type", "unknown")
                    event_counts[event_type] += 1

                    # Scan top-level fields
                    scan_fields(event, event_fields[event_type])

                    # Scan content blocks
                    msg = event.get("message")
                    if isinstance(msg, dict):
                        content = msg.get("content")
                        scan_content_blocks(content, content_blocks)

                    # Scan toolUseResult
                    tur = event.get("toolUseResult")
                    if isinstance(tur, dict):
                        tur_type = tur.get("type", "unknown")
                        scan_fields(tur, tool_result_variants[tur_type])

        except Exception as e:
            print(f"Error reading {fpath}: {e}", file=sys.stderr)
            errors += 1

    # Convert sets to sorted lists for JSON serialization
    report = {
        "scan_directory": str(scan_dir),
        "files_scanned": len(jsonl_files),
        "total_events": total_events,
        "parse_errors": errors,
        "event_types": {
            etype: {
                "count": event_counts[etype],
                "fields": {k: sorted(v) for k, v in sorted(fields.items())}
            }
            for etype, fields in sorted(event_fields.items())
        },
        "content_block_types": {
            btype: {k: sorted(v) for k, v in sorted(fields.items())}
            for btype, fields in sorted(content_blocks.items())
        },
        "tool_use_result_variants": {
            vtype: {k: sorted(v) for k, v in sorted(fields.items())}
            for vtype, fields in sorted(tool_result_variants.items())
        },
    }

    output = json.dumps(report, indent=2)
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        with open(args.output, "w") as f:
            f.write(output)
        print(f"Report written to {args.output}", file=sys.stderr)
    else:
        print(output)

    # Summary
    print(f"\nSummary:", file=sys.stderr)
    print(f"  Files scanned: {len(jsonl_files)}", file=sys.stderr)
    print(f"  Total events: {total_events}", file=sys.stderr)
    print(f"  Parse errors: {errors}", file=sys.stderr)
    print(f"  Event types: {len(event_counts)}", file=sys.stderr)
    for etype, count in sorted(event_counts.items(), key=lambda x: -x[1]):
        print(f"    {etype}: {count}", file=sys.stderr)


if __name__ == "__main__":
    main()
