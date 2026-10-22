# Production TLS files

Supply these real files before running setup.sh:

- fullchain.pem — leaf certificate followed by intermediate certificates.
- privkey.pem — matching unencrypted PEM private key.

The .example files are explanatory placeholders, not usable certificates.
Certificates are mounted read-only into Nginx, never baked into images.
Real PEM files are excluded from Git and the Docker build context.
Use chmod 600 docker/certs/privkey.pem on the server.

Obtain/renew certificates through your CA or ACME tooling on the host.
After renewal, run docker compose restart web. Automated issuance/renewal is
not included; monitor expiry. setup.sh validates hostname, expiry, and key match.
