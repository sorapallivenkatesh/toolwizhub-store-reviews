# Deployment / Hosting

End-to-end deploy for **StoreReviews**:

- **API** → AWS Lambda + API Gateway (HTTP API), Python 3.12, deployed with **AWS SAM**
- **Frontend** → Cloudflare Pages (static `site/`)
- **DNS** → managed in **Cloudflare** (`toolwizhub.com` zone)

Target hostnames:

```
site → store-reviews.toolwizhub.com        (Cloudflare Pages)
api  → api.store-reviews.toolwizhub.com     (API Gateway custom domain)
```

```
Browser → https://store-reviews.toolwizhub.com          (Cloudflare Pages, static)
        → fetch GET https://api.store-reviews.toolwizhub.com/reviews?store=…&id=…
              └─ Cloudflare DNS CNAME → API Gateway custom domain → Lambda → JSON
```

> **Why the API DNS record is manual:** the API runs on AWS but its DNS lives in Cloudflare —
> AWS can't create records in the Cloudflare zone, so the API's CNAME (and the ACM validation
> record) are added by hand in Cloudflare. The frontend domain is near-automatic because
> Cloudflare Pages manages the zone.

---

## Local dev (no Docker, no SAM)

`api/dev.py` runs the Lambda handler in-process over plain HTTP — the same code path as
production, without a container.

```bash
npm run dev     # API → http://localhost:3001/reviews  ·  site → http://localhost:8090
```

`site/config.js` auto-points the frontend at `http://localhost:3001` on localhost, so nothing
to toggle. The App Store works with the Python stdlib alone; for the **Play Store path locally**:

```bash
pip install google-play-scraper      # only needed to test Play locally
```

---

## 0. Prerequisites (one-time)

```bash
brew install aws-sam-cli awscli      # SAM + AWS CLI
sam --version
```

### AWS account setup (dedicated deploy profile)

Use a dedicated named CLI profile so deploys can't land in the wrong account.

1. **IAM user:** `venkatesh_toolwizhub`.
2. **Attach the `sam-deploy` policy** (least-privilege, no admin — see [Appendix C](#appendix-c--sam-deploy-iam-policy)).
3. **Create an access key** (IAM → user → Security credentials → Create access key → CLI).
4. **Configure a named profile:**
   ```bash
   aws configure --profile personal
   #   Access Key ID / Secret  → from step 3
   #   Default region          → ap-south-1
   #   Output                  → json
   ```
5. **Verify + lock the shell to personal (safety check):**
   ```bash
   aws sts get-caller-identity --profile personal     # confirm it's the intended account
   export AWS_PROFILE=personal
   ```

---

## 1. Deploy the API (SAM)

`api/samconfig.toml` already holds the stack name, region and `AllowOrigin`, so a plain
`sam deploy` works (no `--guided` needed after the first run):

```bash
cd api
sam build
sam deploy      # reuses samconfig.toml → stack toolwizhub-store-reviews, region ap-south-1
```

First-time or to change answers: `sam deploy --guided`.

| Prompt | Answer |
| --- | --- |
| Stack Name | `toolwizhub-store-reviews` |
| AWS Region `[ap-south-1]` | press Enter (don't retype — a leading space breaks it) |
| Parameter AllowOrigin | press Enter (already set) |
| Confirm changes before deploy | `y` |
| Allow SAM CLI IAM role creation | `y` |
| `ReviewsFunction has no authentication. Is this okay?` | `y` (public by design) |
| Save arguments to configuration file | `y` |

Note the **ApiUrl** output (e.g. `https://abc123.execute-api.ap-south-1.amazonaws.com`). The API
is live on that raw URL now. Smoke-test:

```bash
curl -s "<ApiUrl>/reviews?store=appstore&id=618783545&limit=5" | head -c 300; echo
```

---

## 2. Custom domain for the API → `api.store-reviews.toolwizhub.com`

Maps the pretty hostname to the HTTP API. Each sub-step runs in a specific place:

| Sub-step | Where |
| --- | --- |
| 2a request cert | AWS (ACM) |
| 2a add validation record | Cloudflare (DNS) |
| 2b custom domain + mapping | AWS (API Gateway) |
| 2c routing CNAME | Cloudflare (DNS) |

> The cert lives in **ACM (AWS) only** — API Gateway terminates TLS and only accepts ACM certs.
> Cloudflare's role is purely DNS (two grey-cloud records).

### 2a. Request + validate the ACM certificate

Request (must be the **same region as the API**, `ap-south-1`):

```bash
aws acm request-certificate \
  --domain-name api.store-reviews.toolwizhub.com \
  --validation-method DNS --region ap-south-1
```

Get the validation CNAME (captures the ARN into `$ARN` for the later steps):

```bash
ARN=$(aws acm list-certificates --region ap-south-1 \
  --query "CertificateSummaryList[?DomainName=='api.store-reviews.toolwizhub.com'].CertificateArn" --output text)
aws acm describe-certificate --region ap-south-1 --certificate-arn "$ARN" \
  --query "Certificate.DomainValidationOptions[].ResourceRecord"
```

Add it in Cloudflare (`toolwizhub.com` zone → DNS → Add record):
- **Type:** CNAME
- **Name:** ⚠️ strip the zone suffix — Cloudflare auto-appends `.toolwizhub.com`:
  ```
  ACM name:  _abc123.api.store-reviews.toolwizhub.com.
  Cloudflare Name:  _abc123.api.store-reviews
  ```
- **Target:** the ACM value, e.g. `_xyz789.mhbtsbpdnt.acm-validations.aws`
- **Proxy:** **DNS only (grey cloud)** — a proxied record breaks validation
- **Save**, then wait for **Issued** (a few minutes, up to ~30):
  ```bash
  aws acm describe-certificate --region ap-south-1 --certificate-arn "$ARN" \
    --query "Certificate.Status" --output text     # PENDING_VALIDATION → ISSUED
  ```

### 2b. Create the API Gateway custom domain + mapping (AWS — API Gateway)

Reuses `$ARN` from 2a; captures the API id into `$API_ID`:

```bash
# create the regional custom domain bound to the cert
aws apigatewayv2 create-domain-name --region ap-south-1 \
  --domain-name api.store-reviews.toolwizhub.com \
  --domain-name-configurations CertificateArn="$ARN",EndpointType=REGIONAL,SecurityPolicy=TLS_1_2

# find the HTTP API id and map it (stage $default, empty path)
API_ID=$(aws apigatewayv2 get-apis --region ap-south-1 \
  --query "Items[?Name=='toolwizhub-store-reviews'].ApiId" --output text)
aws apigatewayv2 create-api-mapping --region ap-south-1 \
  --domain-name api.store-reviews.toolwizhub.com --api-id "$API_ID" --stage '$default'

# the d-xxxx target to point Cloudflare at (step 2c)
aws apigatewayv2 get-domain-name --region ap-south-1 \
  --domain-name api.store-reviews.toolwizhub.com \
  --query "DomainNameConfigurations[0].ApiGatewayDomainName" --output text
```

(Console equivalent: API Gateway → Custom domain names → Create → Regional → pick the ACM cert →
API mappings → map API `toolwizhub-store-reviews`, stage `$default`, empty path.)

### 2c. Point Cloudflare at the target (Cloudflare — DNS)

In the `toolwizhub.com` zone, add:

```
CNAME   api.store-reviews   →   d-xxxx.execute-api.ap-south-1.amazonaws.com
```

Set it **DNS-only (grey cloud)**, NOT proxied. API Gateway routes by SNI/Host — the browser must
reach AWS directly so the TLS SNI matches the custom domain. Proxied (orange) → API Gateway 403 /
TLS handshake errors.

### 2d. Verify

```bash
curl -s "https://api.store-reviews.toolwizhub.com/reviews?store=play&id=social.hunch.app&country=in&limit=5" | head -c 300; echo
```

> **Frontend config:** `site/config.js` already targets `https://api.store-reviews.toolwizhub.com`
> in prod — **no change needed.**

---

## 3. Deploy the frontend (Cloudflare Pages)

1. Cloudflare → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → `toolwizhub-store-reviews`
2. Build settings: Framework preset **None**, Build command **(empty)**, **Build output directory: `site`**
3. **Deploy** → you get `…pages.dev`
4. Project → **Custom domains** → add **`store-reviews.toolwizhub.com`** → Cloudflare auto-creates
   the proxied CNAME + TLS cert.

CLI alternative: `npx wrangler pages deploy site --project-name=store-reviews`.

---

## 4. Verify end-to-end

Open **https://store-reviews.toolwizhub.com**, fetch an app on each store, and confirm
(DevTools → Network) the GET to `api.store-reviews.toolwizhub.com/reviews` returns **200**.

> Test on the real `store-reviews.toolwizhub.com` domain, **not** `*.pages.dev` — CORS is locked to
> the site origin (+ `localhost:8090`).

---

## Appendix A — quick path (skip the custom API domain)

To ship without the API custom domain: after step 1, set `site/config.js` prod `API_BASE` to the
raw `ApiUrl`, commit, push, and skip step 2. The API works identically — only its URL is unbranded.

## Appendix B — redeploy & teardown

```bash
cd api && sam build && sam deploy       # API code changes (reuses samconfig.toml)
git push                                # frontend — Cloudflare Pages auto-redeploys
sam delete --stack-name toolwizhub-store-reviews   # tear down the API
```

## Appendix C — `sam-deploy` IAM policy

Least-privilege policy for SAM deploys (attach to `venkatesh_toolwizhub`). Replace
`<ACCOUNT_ID>` with the personal account ID.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "SamOrchestration", "Effect": "Allow",
      "Action": ["cloudformation:*","lambda:*","apigateway:*","logs:*"], "Resource": "*" },
    { "Sid": "SamArtifactBuckets", "Effect": "Allow", "Action": "s3:*",
      "Resource": ["arn:aws:s3:::aws-sam-cli-*","arn:aws:s3:::aws-sam-cli-*/*"] },
    { "Sid": "SamManagedRoles", "Effect": "Allow",
      "Action": ["iam:CreateRole","iam:DeleteRole","iam:GetRole","iam:PassRole","iam:TagRole","iam:UntagRole","iam:AttachRolePolicy","iam:DetachRolePolicy","iam:PutRolePolicy","iam:DeleteRolePolicy","iam:GetRolePolicy","iam:ListRolePolicies","iam:ListAttachedRolePolicies"],
      "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/*" },
    { "Sid": "CertsForCustomDomains", "Effect": "Allow",
      "Action": ["acm:RequestCertificate","acm:DescribeCertificate","acm:ListCertificates","acm:AddTagsToCertificate","acm:DeleteCertificate"], "Resource": "*" }
  ]
}
```

---

## Troubleshooting

- **`region_name ' ap-south-1' doesn't match a supported format`** — a leading/trailing space in
  the region. Re-run; at the region prompt just press Enter (or pass `--region ap-south-1`).
- **`AccessDenied` during deploy** — the `sam-deploy` policy isn't attached, or `AWS_PROFILE`
  isn't `personal`.
- **ACM cert stuck "Pending validation"** — the validation CNAME isn't in Cloudflare yet, or is
  orange-clouded. Add it **DNS-only**; allow a few minutes.
- **`api.store-reviews…` returns 5xx / TLS handshake errors** — the Cloudflare CNAME is
  orange-clouded. Switch it to **DNS-only (grey cloud)**.
- **CORS errors / duplicate `Access-Control-Allow-Origin`** — CORS is set in both the Lambda
  (`ALLOW_ORIGIN` env) and the API Gateway `CorsConfiguration`. If you see duplicate headers,
  keep CORS in the Lambda (needed for local dev) and drop `CorsConfiguration` from `template.yaml`.
- **Empty App Store feed** — Apple rate-limits by IP; the response carries `throttled:true`.
  Wait a minute. The in-memory cache (10 min) shields repeat/global requests.
- **`ModuleNotFoundError: google_play_scraper` locally** — `pip install google-play-scraper`
  (bundled automatically in the Lambda via `requirements.txt`).
