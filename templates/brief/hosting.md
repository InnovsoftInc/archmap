Set up hosting for the map's site. Do the following:

1. Detect the CI system from `.github/workflows/`, `azure-pipelines.yml`,
   `.gitlab-ci.yml` or `bitbucket-pipelines.yml`.
2. Detect the cloud from Terraform, Bicep or CDK files (`azurerm_*`, `aws_*`,
   `Microsoft.Web/staticSites`) and from the deploy steps of existing workflows
   (`azure/login`, `aws-actions/*`, `Azure/static-web-apps-deploy`).
3. Detect the production trigger from existing deploy workflows (their `on:` and
   `environment: production`).
4. Propose one plain sentence, for example "Deploy the map to a new private
   Static Web App when `main` deploys to production". The choices are the
   detected host, any other supported host, and "Keep it local". Private hosting
   is the default: name how to restrict access for each host (Entra ID for
   Static Web Apps, a private bucket behind CloudFront for S3, a private repo
   for Pages) and never set up a public site without the person saying so.
5. On a yes, write the `deploy` section of `archmap.config.json` and the
   filled-in template, and list the variables or secrets the person must add to
   CI. Never create cloud resources.
