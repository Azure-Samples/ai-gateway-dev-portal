---
name: create-costs-page
description: This prompt is used to create a page for tracking financial metrics related to Azure Monitor custom tables, as part of the FinOps Framework lab.
---

Add a new Costs page as the final entry in the navigation menu, leveraging the same toolbar component already used on the Tokens page. Display a notice at the top of the page clarifying that it depends on Azure Monitor custom tables set up via the FinOps Framework lab: https://github.com/Azure-Samples/AI-Gateway/tree/main/labs/finops-framework. Beneath the notice, build out well-defined sections showcasing essential financial metrics, paired with interactive charts that allow users to track budgets and spending across subscriptions and models. Use the FinOps framework section from the apim-kql skill. Use the `query` endpoint with API version `2020-08-01` to query the linked Log Analytics workspace. The results will be returned in PascalCase format.
