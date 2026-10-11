// Every user-facing string of the page (Egyptian Arabic; package/API names stay English).

export const CATEGORY = {
  security: { label: 'ثغرة أمنية', hint: 'النسخة اللي عندك عليها advisory — حدّث الأول' },
  locked: { label: 'مقفول', hint: 'متثبت عن قصد (override / git / path / تعليق) — متلمسوش من غير ما تقرا السبب' },
  breaking: { label: 'بيكسر', hint: 'major أو الـ changelog بيقول breaking أو محتاج SDK أحدث' },
  attention: { label: 'محتاج انتباه', hint: 'native أو deprecations أو بيرفع minSdk — اقرا قبل ما تحدّث' },
  abandoned: { label: 'مهجور', hint: 'discontinued أو مفيش نسخة جديدة من سنة ونص' },
  safe: { label: 'آمن', hint: 'تحديث جوه الـ constraint ومفيش علامات خطر' },
  upToDate: { label: 'محدّث', hint: 'على آخر نسخة' },
};

export const REASON = {
  advisory: 'فيه ثغرة أمنية بتأثر على نسختك',
  override: 'متثبت في dependency_overrides',
  'non-hosted': 'جاي من git أو path مش من pub.dev',
  'pinned-note': 'تعليق في pubspec بيقول متتحدّثش',
  'exact-pin': 'متثبت على نسخة بالظبط (الأمر بيسيبه exact)',
  'major-bump': 'نسخة major جديدة',
  'changelog-breaking': 'الـ changelog بيذكر breaking',
  'needs-newer-sdk': 'محتاج Flutter/Dart أحدث من اللي عندك',
  'outside-constraint': 'آخر نسخة برّه الـ constraint بتاعك',
  'native-plugin': 'plugin فيه كود native ← store release',
  'changelog-deprecation': 'فيه deprecations',
  'platform-floor-raised': 'ممكن يرفع minSdk / iOS / Gradle / Kotlin',
  discontinued: 'الباكدج متوقف (discontinued)',
  stale: 'مفيش نسخة جديدة من أكتر من سنة ونص',
};

export const BATCH = {
  security: { title: 'حدّث فورًا — ثغرات', why: 'نسختك عليها advisory منشور.' },
  'safe-ota': { title: 'آمنة — Dart بس', why: 'جوه الـ constraint ومن غير كود native: تتحدّث في PR واحد، وتنفع Shorebird patch.' },
  'safe-native': { title: 'آمنة — بس native', why: 'مفيش علامات خطر، بس فيها كود native فمحتاجة store build و pod install.' },
  attention: { title: 'اقرا الـ changelog الأول', why: 'native أو deprecations أو بترفع أقل نسخة Android/iOS. حدّثها وجرّب على جهاز.' },
  breaking: { title: 'واحدة واحدة — breaking', why: 'كل واحدة في PR لوحدها، واقرا الجزء اللي بيكسر في الـ changelog.' },
};

export const SECTION = { main: 'dependencies', dev: 'dev_dependencies', override: 'dependency_overrides' };

export const ERROR = {
  'bad-url': 'اللينك ده مش لينك repo على GitHub. جرّب مثلًا https://github.com/owner/repo',
  'not-found': 'الـ repo أو الـ branch مش موجود — أو private ومحتاج token.',
  'rate-limit': 'GitHub وقف الطلبات مؤقتًا (60 طلب في الساعة من غير token). حط token من الإعدادات أو استنى شوية.',
  unauthorized: 'الـ token مش شغال أو ملوش صلاحية على الـ repo ده.',
  network: 'مشكلة في الاتصال. اتأكد من النت وجرّب تاني.',
  'no-pubspec': 'مفيش pubspec.yaml في المكان ده.',
  'no-flutter': 'مفيش أي pubspec.yaml في الـ repo ده — ده مش مشروع Dart/Flutter.',
  unknown: 'حصلت مشكلة غير متوقعة. جرّب تاني.',
};

export const STAGE = {
  locate: 'بقرا الـ repo…',
  files: 'بقرا pubspec و pubspec.lock…',
  packages: 'بسأل pub.dev عن الباكدجات',
  usage: 'بعدّ الاستخدام في lib/',
};

export const TOOLCHAIN_SOURCE = {
  '.fvmrc': 'من .fvmrc',
  'fvm_config.json': 'من .fvm/fvm_config.json',
  '.tool-versions': 'من .tool-versions',
  manual: 'اختيارك',
  latest: 'آخر stable (المشروع مش مثبّت نسخة)',
  'unknown-version': 'النسخة المثبّتة مش في قايمة Flutter الرسمية',
  none: 'مش معروف',
};

export const AI_ERROR = {
  auth: 'المفتاح مش شغال أو ملوش صلاحية. راجعه من ⚙︎.',
  billing: 'الحساب عند مزوّد الـ AI ملوش رصيد. اشحن أو جرّب Gemini المجاني.',
  rate: 'وصلت للحد المسموح دلوقتي. استنى دقيقة وجرّب تاني.',
  model: 'الموديل ده مش متاح لحسابك. اختار واحد تاني من ⚙︎.',
  refusal: 'الموديل رفض يكمّل الطلب ده. جرّب موديل تاني.',
  busy: 'مزوّد الـ AI مشغول دلوقتي. جرّب كمان شوية.',
  network: 'مشكلة في الاتصال. اتأكد من النت وجرّب تاني.',
  'bad-request': 'الطلب اترفض. جرّب موديل تاني أو باكدج تاني.',
  aborted: 'وقّفته.',
  unknown: 'حصلت مشكلة غير متوقعة. جرّب تاني.',
};
