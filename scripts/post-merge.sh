#!/bin/bash
set -e

# Install dependencies
npm install --legacy-peer-deps

# Apply schema (idempotent — uses CREATE IF NOT EXISTS)
psql "$DATABASE_URL" -f server/schema.sql

# Seed default settings (idempotent — uses ON CONFLICT DO NOTHING)
psql "$DATABASE_URL" -f server/seed.sql
