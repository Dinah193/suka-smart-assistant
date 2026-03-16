# Planner API Scaffolding

This route file adds preservation-aware planner endpoints:

- GET /api/planners/meal
- POST /api/planners/meal
- GET /api/planners/storehouse
- POST /api/planners/storehouse/inventory
- GET /api/planners/homestead

Integration model:
- PostgreSQL remains system of record for plans, lots, and preservation inventory.
- MongoDB stores raw ingestion and flexible snapshots.
- Neo4j receives projection updates to power substitutions, explainability, and collaboration.

Mount this router from the server bootstrap (example):

app.use("/api/planners", require("./routes/planners"));
