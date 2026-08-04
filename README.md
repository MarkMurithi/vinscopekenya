# Vinscope Kenya

A vehicle-history web app prototype with a PostgreSQL-backed backend.

## Run locally

1. Start PostgreSQL locally with Docker:
   ```bash
   docker-compose up -d
   ```
2. Copy the example environment file:
   ```bash
   copy .env.example .env
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the backend:
   ```bash
   node server.js
   ```
5. Start the frontend:
   ```bash
   npm run dev
   ```
6. Open the frontend at http://localhost:5173/

## Deploy to Render

1. Create a new Render Web Service from this repository.
2. Render will read [render.yaml](render.yaml).
3. Connect the managed PostgreSQL database created by Render to the service automatically.
4. Deploy the service.

## API

- GET /health
- GET /api/vehicles/:vin
- POST /api/vehicles
