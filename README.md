# Flutter Deps Watch

**الموقع:** https://youssef336.github.io/flutter-deps-watch/

حط لينك أي repo Flutter على GitHub، والصفحة تقولك حالة كل باكدج في `pubspec.yaml`:
إيه القديم، إيه اللي بيكسر، إيه اللي عليه ثغرة، وبأي ترتيب تحدّث. كله بيشتغل في
المتصفح: مفيش server ولا تسجيل دخول ولا build step.

## بيعمل إيه

- **بيقرا** `pubspec.yaml` (ومعاه التعليقات اللي فوق كل باكدج) و `pubspec.lock`
  و `.fvmrc` من الـ repo. لو الـ repo فيه أكتر من مشروع (monorepo) بيسألك تختار أنهي واحد.
- **بيسأل pub.dev** عن كل باكدج: آخر نسخة وتاريخها، والـ SDK اللي محتاجه، ولو كان
  discontinued، والـ pub points، والثغرات المنشورة (advisories).
- **بيقولك هتاخد إيه من كل تحديث**: بيجيب الـ CHANGELOG من أرشيف الباكدج نفسه، ياخد بس
  اللي بين نسختك وآخر نسخة، ويقسمه لـ **بيكسر / اتضاف / اتصلح** (والباقي docs و dependencies
  في «تاني»). بيفهم أشكال الـ changelog المشهورة: `**FIX**`/`**FEAT**` بتاعة melos، و
  `fix:`/`feat!:`، و `### Added`/`### Fixed`، و `**Bugs**`، و `Fixed:`، و «Fixes …/Adds …».
  العدد بيظهر على كل باكدج، وعلى كل مجموعة في الخطة («هتاخد: 12 تصليح · 5 جديد»)، وعلى
  المشروع كله.
- **«في كودك»**: لو حاجة بتكسر أو اتصلحت بتذكر API بين `backticks`، الصفحة بتدوّر عليه في
  الفايلات اللي بتعمل import للباكدج ده عندك، ولو لقته بتعلّم عليه.
- **بيعدّ الاستخدام**: أنهي فايلات في `lib/` بتعمل import لكل باكدج.
- **بيصنّف** كل باكدج في واحدة من دول:

  | التصنيف | يعني |
  |---|---|
  | ثغرة أمنية | نسختك عليها advisory منشور |
  | مقفول | override / git / path / تعليق زي "do not bump" |
  | بيكسر | major، أو الـ changelog بيقول breaking، أو محتاج Flutter/Dart أحدث |
  | محتاج انتباه | plugin فيه native، أو deprecations، أو بيرفع minSdk/iOS، أو متثبت على نسخة بالظبط |
  | مهجور | discontinued أو مفيش نسخة جديدة من سنة ونص |
  | آمن | تحديث جوه الـ constraint ومفيش علامات خطر |

- **بيطلعلك خطة**: مجموعات بالترتيب (أمان، آمن Dart، آمن native، انتباه، breaking)،
  ولكل مجموعة أمر `flutter pub` جاهز تنسخه. الباكدجات اللي من نفس الـ repo
  (firebase_*، riverpod، *_plus …) بتتحرك مع بعض دايمًا.
- **التقرير ليه لينك** (`?repo=owner/name`) تبعته لحد، وزرار ينسخه Markdown عشان تحطه في PR.

## Private repos

من ⚙︎ حط GitHub token (fine-grained، صلاحيته **Contents: Read-only** بس). الـ token
بيروح لـ `api.github.com` وبس، ومش بيتحفظ غير لو علّمت «افتكره». من غير token الـ repos
العامة شغالة عادي، بس GitHub بيسمح بـ 60 طلب API في الساعة (كل فحص بياخد 2).

## الـ Flutter اللي بيقارن بيه

بياخده من `.fvmrc` أو `.fvm/fvm_config.json` أو `.tool-versions`. لو المشروع مش مثبّت
نسخة بيقارن بآخر stable، وتقدر تختار نسخة تانية من القايمة.

## Develop

Plain ES modules, no dependencies, no build.

```bash
python3 -m http.server 8000      # then open http://localhost:8000
bash tool/test.sh                # unit tests in headless Chrome
```

| file | role |
|---|---|
| `js/semver.js` | pub-flavoured versions and constraints |
| `js/pubspec.js` | pubspec / lock / changelog / advisory parsers (keeps comments) |
| `js/classify.js` | verdict per package + upgrade plan |
| `js/notes.js` | changelog → breaking / feature / fix / other, and "used in your code" hits |
| `js/github.js`, `js/pub.js` | GitHub, pub.dev and Flutter-release lookups (all CORS-enabled) |
| `js/scan.js` | one scan, end to end |
| `js/main.js`, `js/labels.js`, `js/md.js` | page, strings, safe markdown for changelogs |

Limits: no `pub outdated`-style resolution (a package another dependency holds back
still shows as upgradable), and "native" means the package is a Flutter plugin, not
that this particular release changed native code.

MIT
