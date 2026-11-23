# Vendored `@devicebasedauth/verify`

These files are an unmodified copy of `packages/verify/src/*.js` (tests excluded) from the
devicebasedauth.org repository (`device-based-auth`), at commit
`60aa3c3c1a3f697d0a5597d3a2376ccaedf43877` ("S13, B5: TPM keys on Windows through the Platform Crypto Provider; pack every CLI module"), the same commit hashbin vendors.

**Do not edit these files here.** devicebasedauth.org requires one evaluator implementation that
passes every vector in its `spec/vectors/`; a local fix would fork it. Fix the upstream package,
then re-copy all files and update the commit and hashes below in the same commit.

cronly uses `verifier.js` (`createVerifier`), `site.js` (`createOidcClient`) and `replay-do.js`
(`ReplayCacheDO`, `durableReplayCache`) from `src/auth/dba.js`, and `issuer.js` and `events.js` only
in tests (to act as a fake issuer). The code is zero-dependency and uses only
WebCrypto, `CompressionStream`/`DecompressionStream` and `fetch`.

| File | SHA-256 |
|------|---------|
| credential.js | `26bf8e6b1961402601bf2af6e99fe84684528fa93bb6a73300e71e18a28b05b2` |
| events.js | `1bfa7c11f9069ee0b6ffb20f0eaedc987380324c6f1a3c81a70adb0645ab5284` |
| grants.js | `32559167506e6c9b3aaa541ce400b8b17d6be93eda7958daa429ced958a9f618` |
| index.js | `1fb495e8c4b862ef6daf24e05d8b4972761e6f4f9bfd6f7ca217aabc3166a5d1` |
| issuer.js | `65072ae1ffd393577327489a08d4a3453e3f7cd3893f133315c64cb8647140f2` |
| jose.js | `10ba75e065dcc95b242eb3b6c67ad7873d700f1f4ca4dd55a62f8a23b7e58544` |
| replay-do.js | `5c9d5b9ea7d467e4653bc1ca97736e682233655023e1d0c1f325e936d36ce43c` |
| site.js | `591e5fd8b25ab0b8ba7bc51c3e4fc4c818b063e244489b702357efbdec19543c` |
| status-list.js | `85da1479c03641bd4b0159304115057da425f88ae1cac267b5b172d848da34cc` |
| verifier.js | `bd779103be1b364a7d3538bc21a9ec6ad69736cb859a9cdf5a86510ac1d4ecb3` |

To refresh (from a checkout of both repositories side by side):

```sh
for f in ../device-based-auth/packages/verify/src/*.js; do
  case "$f" in *.test.js) ;; *) cp "$f" src/vendor/devicebasedauth/ ;; esac
done
(cd src/vendor/devicebasedauth && sha256sum *.js)
git -C ../device-based-auth rev-parse HEAD
```
