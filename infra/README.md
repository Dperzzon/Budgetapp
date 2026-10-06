# Azure infrastructure

Azure is intentionally not used in this version of the app because the solution is local-first and designed to minimize operational cost.

If a future Azure dependency becomes necessary, the preferred model is a tightly-scoped, serverless integration such as Azure Functions on a consumption plan. Any future Azure infrastructure should be defined as code under this directory.
