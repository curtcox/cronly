# Vendored `@devicebasedauth/verify`

These files are an unmodified copy of `packages/verify/src/*.js` (tests excluded) from the
devicebasedauth.org repository (`device-based-auth`), at commit
`829d033f8ceba1086f35b356749d388b80fe51a0` ("B10 N4: the DNS address source in the verify library").
hashbin still vendors `60aa3c3`; this refresh adds credential `ver` 2 and the `net` grant
constraint (`net.js`, `ip.js`), timed DPoP nonces (`rtt.js`) and the DNS address source (`dns.js`).

**Do not edit these files here.** devicebasedauth.org requires one evaluator implementation that
passes every vector in its `spec/vectors/`; a local fix would fork it. Fix the upstream package,
then re-copy all files and update the commit and hashes below in the same commit.

cronly uses `verifier.js` (`createVerifier`), `site.js` (`createOidcClient`) and `replay-do.js`
(`ReplayCacheDO`, `durableReplayCache`) from `src/auth/dba.js`, `dns.js`
(`createDohResolver`, `grantDnsNames`), and `issuer.js` and `events.js` only
in tests (to act as a fake issuer). The code is zero-dependency and uses only
WebCrypto, `CompressionStream`/`DecompressionStream` and `fetch`.

| File | SHA-256 |
|------|---------|
| credential.js | `5f3d8bd0214fa69f5b4f5f8c874645bd30efd100728a68317481430a8d953df7` |
| dns.js | `aa65f416683001401c60211b863dbe5713a61166f7f9632985f668c906be69f5` |
| events.js | `1bfa7c11f9069ee0b6ffb20f0eaedc987380324c6f1a3c81a70adb0645ab5284` |
| grants.js | `bd986ce9747f66cdd3142594269e1953f066c5aad412dc83e4914198a7b412e8` |
| index.js | `03ada43a4a10a69d2b1dca43d0f48b16664b5124ac0457a906853c7427e2cbcd` |
| ip.js | `4912227a9a7768f1481407dc57c5b4f65f933aac147cc831349385c448218d03` |
| issuer.js | `65072ae1ffd393577327489a08d4a3453e3f7cd3893f133315c64cb8647140f2` |
| jose.js | `10ba75e065dcc95b242eb3b6c67ad7873d700f1f4ca4dd55a62f8a23b7e58544` |
| net.js | `4df088abf50ecd30fa316f5ca6665243d98ef9c527a654172c98ba7541580a82` |
| replay-do.js | `5c9d5b9ea7d467e4653bc1ca97736e682233655023e1d0c1f325e936d36ce43c` |
| rtt.js | `423915025857f5293bb9b2824d3619fe9d57ff51466e408046e4b32b698562d4` |
| site.js | `591e5fd8b25ab0b8ba7bc51c3e4fc4c818b063e244489b702357efbdec19543c` |
| status-list.js | `85da1479c03641bd4b0159304115057da425f88ae1cac267b5b172d848da34cc` |
| verifier.js | `36ab97dce4f1aa8116a4bb0e7583d9ded1ad919992604da4af2a34c984364db4` |

To refresh (from a checkout of both repositories side by side):

```sh
for f in ../device-based-auth/packages/verify/src/*.js; do
  case "$f" in *.test.js) ;; *) cp "$f" src/vendor/devicebasedauth/ ;; esac
done
(cd src/vendor/devicebasedauth && sha256sum *.js)
git -C ../device-based-auth rev-parse HEAD
```
