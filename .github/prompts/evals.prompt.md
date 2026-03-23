---
name: create-evals-page
description: This prompt is used to create a page for evaluating model performance using the promptfoo framework.
---

Create a Model Evals page powered by the promptfoo framework (https://github.com/promptfoo/promptfoo) after the Logs page. This page will leverage the same data used on the Logs page, reusing its toolbar and logs table to present a sample of input evaluations. Users should be able to configure the Inference API endpoint (used as the Azure endpoint) and select a subscription whose API key will authenticate requests. The configuration toolbar should also expose model to use, a multiple selection of the available model-graded metrics along with Start and Cancel controls. While evaluations are in progress, real-time results and a progress indicator should be displayed, culminating in a summary view once all evaluations are complete.