targetScope = 'subscription'

@description('Deployment location')
param location string = 'westeurope'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-budgetapp-local'
  location: location
}

// Azure is intentionally not used in v1 because the app is local-first and cost-sensitive.
// If a future cloud integration is required, it should be added here in a minimal, serverless form.
output resourceGroupName string = rg.name
