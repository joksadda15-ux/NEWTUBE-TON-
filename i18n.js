/* i18n.js — NEWTUBE mini-app languages: English (default), Russian, Arabic.
 *
 * ⚠️ NEW (big update). Scope: the MINI APP UI only (index.html). Bot messages,
 * admin panel and server logs stay English on purpose.
 *
 * HOW IT WORKS (so the 4000-line index.html didn't have to be rewritten):
 *   • The app keeps writing plain English text into the DOM, exactly as before.
 *   • This file watches the DOM (MutationObserver) and swaps every English
 *     text node / placeholder / title / aria-label for its Russian or Arabic
 *     equivalent from the DICTIONARY below. English is the "source" language:
 *     the original text is remembered per node, so switching language (or back
 *     to English) always re-translates from the English source.
 *   • Dictionary KEYS are the exact English strings. A key may contain numbered
 *     placeholders {0} {1} … for dynamic parts, e.g.
 *         'Level {0}'  →  'Уровень {0}'
 *     Numbers, names, wallet addresses etc. are captured and copied through.
 *   • To translate a NEW piece of UI text: add one line to DICTIONARY
 *     (English, Russian, Arabic). Text that has no entry simply stays English.
 *
 *   window.i18n.lang()        current language code ('en' | 'ru' | 'ar')
 *   window.i18n.setLang(code) switch + persist (localStorage 'nt_lang')
 *   window.i18n.t(key, ...args)  translate a string from JS code (for native
 *                                popups that don't go through the DOM)
 *   window.i18n.LANGS         { en:{name,short,dir}, ru:{…}, ar:{…} }
 */
(function () {
    'use strict';

    var LANGS = {
        en: { name: 'English', short: 'EN', dir: 'ltr' },
        ru: { name: 'Русский', short: 'RU', dir: 'ltr' },
        ar: { name: 'العربية', short: 'AR', dir: 'rtl' },
    };
    var STORAGE_KEY = 'nt_lang';

    // ── DICTIONARY: [English, Russian, Arabic] ─────────────────────────────
    var DICTIONARY = [
        // ── Onboarding / welcome ticket ──
        ['Membership ticket', 'Членский билет', 'تذكرة العضوية'],
        ['Welcome to NEW', 'Добро пожаловать в NEW', 'مرحبًا بك في NEW'],
        ['Tune in & watch', 'Смотрите и зарабатывайте', 'شاهد واكسب'],
        ['Every broadcast you watch earns WTC — no investment, ever.', 'Каждая просмотренная трансляция приносит WTC — без вложений, никогда.', 'كل بث تشاهده يمنحك WTC — بدون أي استثمار، أبدًا.'],
        ['Balance builds', 'Баланс растёт', 'رصيدك ينمو'],
        ['Convert WTC to USDT, refer friends to unlock bigger cash-outs.', 'Обменивайте WTC на USDT и приглашайте друзей, чтобы открыть более крупные выводы.', 'حوّل WTC إلى USDT وادعُ أصدقاءك لفتح سحوبات أكبر.'],
        ['Cash out', 'Вывод средств', 'اسحب أرباحك'],
        ['Withdraw straight to Binance or your Tonkeeper wallet.', 'Выводите средства прямо на Binance или в кошелёк Tonkeeper.', 'اسحب مباشرة إلى Binance أو محفظة Tonkeeper الخاصة بك.'],
        ['Continue', 'Продолжить', 'متابعة'],

        // ── Terms & Conditions (new-user gate) ──
        ['Before you start', 'Перед началом', 'قبل أن تبدأ'],
        ['Terms & Conditions', 'Условия использования', 'الشروط والأحكام'],
        ['⚠️ Important notice for new users', '⚠️ Важное уведомление для новых пользователей', '⚠️ إشعار مهم للمستخدمين الجدد'],
        ['Important notice for new users', 'Важное уведомление для новых пользователей', 'إشعار مهم للمستخدمين الجدد'],
        ['Please read every rule below. By agreeing, you confirm that you understand and accept all of them.', 'Внимательно прочитайте все правила ниже. Нажимая «Согласен», вы подтверждаете, что понимаете и принимаете каждое из них.', 'يرجى قراءة كل القواعد أدناه. بموافقتك تؤكد أنك فهمتها وتقبلها جميعًا.'],
        ['Scroll down to read all rules', 'Прокрутите вниз, чтобы прочитать все правила', 'مرّر لأسفل لقراءة كل القواعد'],
        ['One person, one account', 'Один человек — один аккаунт', 'شخص واحد، حساب واحد'],
        ['Each person may have only one account. Creating or using multiple accounts is not allowed.', 'У каждого человека может быть только один аккаунт. Создавать и использовать несколько аккаунтов запрещено.', 'يُسمح لكل شخص بحساب واحد فقط. يُمنع إنشاء أو استخدام عدة حسابات.'],
        ['One device, one account', 'Одно устройство — один аккаунт', 'جهاز واحد، حساب واحد'],
        ['Only one account can be used on a device. Opening a second account on the same device is blocked.', 'На одном устройстве можно использовать только один аккаунт. Вход во второй аккаунт на том же устройстве блокируется.', 'يمكن استخدام حساب واحد فقط على كل جهاز. يتم حظر فتح حساب ثانٍ على نفس الجهاز.'],
        ['No cheating — permanent ban', 'Никакого обмана — бан навсегда', 'ممنوع الغش — حظر دائم'],
        ['Bots, scripts, auto-clickers, fake or self-referrals, or any other attempt to cheat the system will get your account banned. Banned accounts cannot withdraw.', 'Боты, скрипты, автокликеры, фейковые рефералы и приглашение самого себя, а также любые другие попытки обмануть систему приведут к бану аккаунта. Заблокированные аккаунты не могут выводить средства.', 'استخدام البوتات أو السكربتات أو النقر الآلي أو الإحالات الوهمية أو الإحالة الذاتية أو أي محاولة أخرى للغش سيؤدي إلى حظر حسابك. لا يمكن للحسابات المحظورة السحب.'],
        ['{0}-hour wait for new users', 'Ожидание {0} ч для новых пользователей', 'انتظار {0} ساعة للمستخدمين الجدد'],
        ['A new account can make its first withdrawal only {0} hours after joining.', 'Новый аккаунт может сделать первый вывод только через {0} ч после регистрации.', 'لا يمكن للحساب الجديد إجراء أول عملية سحب إلا بعد {0} ساعة من الانضمام.'],
        ['Withdrawal processing time', 'Время обработки вывода', 'مدة معالجة السحب'],
        ['After you submit a withdrawal request it is paid within {0}–{1} hours.', 'После отправки заявки на вывод выплата производится в течение {0}–{1} ч.', 'بعد إرسال طلب السحب يتم الدفع خلال {0} إلى {1} ساعة.'],
        ['Check your wallet address', 'Проверьте адрес кошелька', 'تحقق من عنوان محفظتك'],
        ['Before every withdrawal, double-check your wallet address or Binance UID. Your first withdrawal address becomes your permanent wallet, and payments sent to a wrong address cannot be recovered.', 'Перед каждым выводом тщательно проверяйте адрес кошелька или Binance UID. Адрес первого вывода становится вашим постоянным кошельком, а платежи на неверный адрес вернуть невозможно.', 'قبل كل عملية سحب، تحقق جيدًا من عنوان محفظتك أو معرّف Binance. يصبح عنوان أول سحب محفظتك الدائمة، ولا يمكن استرجاع المدفوعات المرسلة إلى عنوان خاطئ.'],
        ['Fees and requirements', 'Комиссии и требования', 'الرسوم والمتطلبات'],
        ['Withdrawal fees apply, and you must complete the requirements shown on the withdraw screen (tasks, ads and referrals).', 'При выводе взимаются комиссии, и нужно выполнить требования, указанные на экране вывода (задания, реклама и рефералы).', 'تُطبَّق رسوم على السحب، ويجب استيفاء المتطلبات الظاهرة في شاشة السحب (المهام والإعلانات والإحالات).'],
        ['Stay in our community', 'Оставайтесь в нашем сообществе', 'ابقَ في مجتمعنا'],
        ['You must stay in our official channel and community to keep earning.', 'Чтобы продолжать зарабатывать, нужно оставаться в нашем официальном канале и сообществе.', 'يجب البقاء في قناتنا الرسمية ومجتمعنا لمواصلة الربح.'],
        ['Suspicious activity', 'Подозрительная активность', 'النشاط المشبوه'],
        ['Suspicious or bot-like activity may freeze your balance while the admin reviews your account.', 'Подозрительная активность или поведение, похожее на бота, может привести к заморозке баланса на время проверки аккаунта администратором.', 'قد يؤدي النشاط المشبوه أو الشبيه بالبوتات إلى تجميد رصيدك أثناء مراجعة المشرف لحسابك.'],
        ['Inactive accounts', 'Неактивные аккаунты', 'الحسابات غير النشطة'],
        ['Accounts that are not opened for 90 days are deleted automatically.', 'Аккаунты, которые не открывались 90 дней, удаляются автоматически.', 'يتم حذف الحسابات التي لم تُفتح لمدة 90 يومًا تلقائيًا.'],
        ['Age limit', 'Возрастное ограничение', 'الحد الأدنى للعمر'],
        ['You must be 13 or older to use this app.', 'Для использования приложения вам должно быть не менее 13 лет.', 'يجب أن يكون عمرك 13 عامًا أو أكثر لاستخدام هذا التطبيق.'],
        ['Rule changes', 'Изменение правил', 'تغيير القواعد'],
        ['These terms can change. If they do, you will be asked to accept them again before you continue.', 'Эти условия могут меняться. В этом случае вас попросят принять их снова, прежде чем продолжить.', 'قد تتغير هذه الشروط. وفي هذه الحالة سيُطلب منك قبولها مجددًا قبل المتابعة.'],
        ['I have read and agree to the Terms & Conditions', 'Я прочитал(а) Условия использования и согласен(на) с ними', 'لقد قرأت الشروط والأحكام وأوافق عليها'],
        ['I Agree & Start', 'Согласен, начать', 'أوافق وأبدأ'],
        ['Saving...', 'Сохранение...', 'جارٍ الحفظ...'],
        ['Could not save your agreement — please try again.', 'Не удалось сохранить ваше согласие — попробуйте ещё раз.', 'تعذّر حفظ موافقتك — حاول مرة أخرى.'],
        ['Terms of use', 'Условия использования', 'شروط الاستخدام'],
        ['I have read and agree to the terms', 'Я прочитал(а) условия и согласен(на)', 'لقد قرأت الشروط وأوافق عليها'],
        ['Get Started', 'Начать', 'ابدأ'],

        // ── Join gate ──
        ['You left our', 'Вы покинули наш', 'لقد غادرت'],
        ['channel / community', 'канал / сообщество', 'القناة / المجتمع'],
        ['One last step', 'Последний шаг', 'خطوة أخيرة'],
        ['to earn', 'чтобы зарабатывать', 'لتبدأ الربح'],
        ['Please re-join to keep using NEWTUBE.', 'Пожалуйста, вернитесь, чтобы продолжить пользоваться NEWTUBE.', 'يرجى إعادة الانضمام لمتابعة استخدام NEWTUBE.'],
        ['Join our official channel & community to unlock NEWTUBE.', 'Вступите в наш официальный канал и сообщество, чтобы открыть NEWTUBE.', 'انضم إلى قناتنا الرسمية ومجتمعنا لفتح NEWTUBE.'],
        ['Join Channel', 'Вступить в канал', 'انضم إلى القناة'],
        ['Join Community', 'Вступить в сообщество', 'انضم إلى المجتمع'],
        ['Join Now →', 'Вступить →', 'انضم الآن ←'],
        ["I've joined, check now", 'Я вступил(а), проверить', 'لقد انضممت، تحقّق الآن'],
        ["⚡ We'll verify instantly", '⚡ Проверим мгновенно', '⚡ سنتحقق فورًا'],
        ['Checking...', 'Проверка...', 'جارٍ التحقق...'],
        ['Not joined in both places yet.', 'Вы ещё не вступили в оба места.', 'لم تنضم إلى المكانين بعد.'],

        // ── Navigation / header ──
        ['Home', 'Главная', 'الرئيسية'],
        ['Video', 'Видео', 'الفيديو'],
        ['Earning', 'Заработок', 'الأرباح'],
        ['Task', 'Задания', 'المهام'],
        ['Refer', 'Друзья', 'الإحالة'],
        ['History', 'История', 'السجل'],
        ['Profile', 'Профиль', 'الملف الشخصي'],
        ['Language', 'Язык', 'اللغة'],
        ['Choose your language', 'Выберите язык', 'اختر لغتك'],
        ['Close', 'Закрыть', 'إغلاق'],
        ['Cancel', 'Отмена', 'إلغاء'],
        ['Copy ledger ID', 'Копировать ID', 'نسخ المعرّف'],
        ['Loading...', 'Загрузка...', 'جارٍ التحميل...'],
        ['Try again', 'Повторить', 'أعد المحاولة'],
        ['Retry', 'Повторить', 'إعادة المحاولة'],

        // ── Withdraw history ──
        ['Pending', 'В ожидании', 'قيد الانتظار'],
        ['🕓 Pending', '🕓 В ожидании', '🕓 قيد الانتظار'],
        ['✅ Received', '✅ Получено', '✅ تم الاستلام'],
        ['Received', 'Получено', 'تم الاستلام'],
        ['🕓 Withdraw History', '🕓 История выводов', '🕓 سجل السحب'],
        ["Couldn't load history ({0}). Close the app and reopen it.", 'Не удалось загрузить историю ({0}). Закройте и снова откройте приложение.', 'تعذّر تحميل السجل ({0}). أغلق التطبيق وأعد فتحه.'],
        ['No withdraw requests yet.', 'Заявок на вывод пока нет.', 'لا توجد طلبات سحب بعد.'],
        ['Failed to load history.', 'Не удалось загрузить историю.', 'فشل تحميل السجل.'],
        ['⏱ Expected within {0}–{1} hours', '⏱ Ожидается в течение {0}–{1} ч', '⏱ متوقع خلال {0} إلى {1} ساعة'],

        // ── Gift / celebration ──
        ['Congratulations!', 'Поздравляем!', 'تهانينا!'],
        ['You have received', 'Вы получили', 'لقد استلمت'],
        ['Tap anywhere to continue', 'Нажмите в любом месте, чтобы продолжить', 'اضغط في أي مكان للمتابعة'],
        ['🎉 Congratulations!', '🎉 Поздравляем!', '🎉 تهانينا!'],
        ['You have received a gift from admin', 'Вы получили подарок от администратора', 'لقد استلمت هدية من المشرف'],
        ['Reason', 'Причина', 'السبب'],
        ['🎁 Claim Gift', '🎁 Забрать подарок', '🎁 استلم الهدية'],
        ['Claiming...', 'Получение...', 'جارٍ الاستلام...'],
        ['Gift already claimed or expired.', 'Подарок уже получен или срок его действия истёк.', 'تم استلام الهدية مسبقًا أو انتهت صلاحيتها.'],
        ['Gift claimed successfully!', 'Подарок успешно получен!', 'تم استلام الهدية بنجاح!'],
        ['Awesome!', 'Отлично!', 'رائع!'],
        ['Something went wrong, try again.', 'Что-то пошло не так, попробуйте ещё раз.', 'حدث خطأ ما، حاول مرة أخرى.'],

        // ── Home ──
        ['WTC Balance', 'Баланс WTC', 'رصيد WTC'],
        ['Level {0}', 'Уровень {0}', 'المستوى {0}'],
        ['Ledger ID', 'ID аккаунта', 'معرّف الحساب'],
        ['Ledger ID copied!', 'ID скопирован!', 'تم نسخ المعرّف!'],
        ['Withdraw', 'Вывод', 'سحب'],
        ['Cash out your earnings', 'Выведите свой заработок', 'اسحب أرباحك'],
        ['Spin Wheel', 'Колесо удачи', 'عجلة الحظ'],
        ['Win WTC rewards', 'Выигрывайте WTC', 'اربح مكافآت WTC'],
        ['Have a promo code?', 'Есть промокод?', 'هل لديك رمز ترويجي؟'],
        ['Redeem it for free WTC', 'Активируйте его и получите WTC', 'استبدله بـ WTC مجانًا'],
        ['Redeem', 'Активировать', 'استبدال'],
        ['Watch Videos', 'Смотреть видео', 'شاهد الفيديوهات'],
        ['Earn WTC', 'Зарабатывайте WTC', 'اكسب WTC'],
        ['Tasks', 'Задания', 'المهام'],
        ['Complete & Earn', 'Выполняйте и зарабатывайте', 'أنجز واكسب'],
        ['Invite & Earn', 'Приглашайте и зарабатывайте', 'ادعُ واكسب'],
        ['Buy Referral', 'Купить реферала', 'اشترِ إحالة'],
        ['{0} TON each', '{0} TON за шт.', '{0} TON للواحدة'],
        ['Leaderboard', 'Рейтинг', 'المتصدرون'],
        ['Top earners ranking', 'Топ лучших', 'ترتيب الأفضل'],
        ['Weekly Contest', 'Недельный конкурс', 'المسابقة الأسبوعية'],
        ['Win exciting rewards', 'Выигрывайте призы', 'اربح جوائز مثيرة'],
        ['Payment Channel', 'Канал выплат', 'قناة المدفوعات'],
        ['Latest payment proof', 'Свежие подтверждения выплат', 'أحدث إثباتات الدفع'],
        ['Official Channel', 'Официальный канал', 'القناة الرسمية'],
        ['Join our channel', 'Вступайте в наш канал', 'انضم إلى قناتنا'],
        ['Platform stats', 'Статистика платформы', 'إحصاءات المنصة'],
        ['Videos to watch', 'Видео для просмотра', 'فيديوهات للمشاهدة'],
        ['Tasks available', 'Доступно заданий', 'مهام متاحة'],
        ['Your referrals', 'Ваши рефералы', 'إحالاتك'],
        ['Watch a bonus ad', 'Смотреть бонусную рекламу', 'شاهد إعلانًا إضافيًا'],
        ['+{0} WTC · {1}/{2} left today', '+{0} WTC · осталось сегодня: {1}/{2}', '+{0} WTC · المتبقي اليوم {1}/{2}'],
        ['Please enter a code.', 'Пожалуйста, введите код.', 'يرجى إدخال الرمز.'],
        ['Checking code...', 'Проверка кода...', 'جارٍ التحقق من الرمز...'],
        ['Loading ad...', 'Загрузка рекламы...', 'جارٍ تحميل الإعلان...'],
        ['+{0} WTC added!', '+{0} WTC добавлено!', 'تمت إضافة +{0} WTC!'],
        ['Promo code', 'Промокод', 'الرمز الترويجي'],
        ['Redeem a code for extra WTC.', 'Активируйте код и получите дополнительные WTC.', 'استبدل الرمز للحصول على WTC إضافية.'],
        ['Enter 6-digit code', 'Введите 6-значный код', 'أدخل رمزًا من 6 أرقام'],

        // ── Leaderboard / weekly contest ──
        ['🏆 Top 20 Referrers', '🏆 Топ-20 по рефералам', '🏆 أفضل 20 مُحيلًا'],
        ['Ranked by lifetime referrals.', 'Рейтинг по числу рефералов за всё время.', 'الترتيب حسب إجمالي الإحالات.'],
        ['No data yet.', 'Данных пока нет.', 'لا توجد بيانات بعد.'],
        ['{0} refs', '{0} реф.', '{0} إحالة'],
        ['📅 Weekly Referral Contest', '📅 Недельный конкурс рефералов', '📅 مسابقة الإحالات الأسبوعية'],
        ['Refer {0}+ new people THIS WEEK to qualify. Top {1} qualifying referrers win a reward. Resets when the admin ends the week.', 'Пригласите {0}+ новых людей НА ЭТОЙ НЕДЕЛЕ, чтобы участвовать. Топ-{1} участников получают награду. Сбрасывается, когда администратор завершает неделю.', 'ادعُ {0}+ أشخاص جدد هذا الأسبوع للتأهل. يفوز أفضل {1} مُحيلين مؤهلين بجائزة. تُعاد التصفية عندما ينهي المشرف الأسبوع.'],
        ['Your referrals this week', 'Ваши рефералы на этой неделе', 'إحالاتك هذا الأسبوع'],
        ["✅ You currently qualify for this week's reward!", '✅ Вы уже участвуете в награде этой недели!', '✅ أنت مؤهل حاليًا لجائزة هذا الأسبوع!'],
        ['⏳ {0} more referral{1} to qualify.', '⏳ Осталось рефералов до участия: {0}.', '⏳ تحتاج {0} إحالة إضافية للتأهل.'],
        ["This week's top referrers", 'Лучшие по рефералам на этой неделе', 'أفضل المُحيلين هذا الأسبوع'],
        ['No referrals yet this week — be the first!', 'На этой неделе рефералов пока нет — станьте первым!', 'لا توجد إحالات هذا الأسبوع بعد — كن الأول!'],

        // ── Spin wheel ──
        ['🎡 Spin Wheel', '🎡 Колесо удачи', '🎡 عجلة الحظ'],
        ['Watch a quick ad, then spin to win WTC!', 'Посмотрите короткую рекламу и крутите колесо, чтобы выиграть WTC!', 'شاهد إعلانًا قصيرًا ثم أدر العجلة لتربح WTC!'],
        ['🎁 {0} bonus spin{1} from referrals, plus a free spin in {2}', '🎁 Бонусных вращений за рефералов: {0}, плюс бесплатное вращение через {2}', '🎁 {0} دورة إضافية من الإحالات، بالإضافة إلى دورة مجانية خلال {2}'],
        ['🎁 {0} bonus spin{1} from referrals, plus a free spin ready now', '🎁 Бонусных вращений за рефералов: {0}, плюс бесплатное вращение уже доступно', '🎁 {0} دورة إضافية من الإحالات، بالإضافة إلى دورة مجانية جاهزة الآن'],
        ['Next free spin in {0}', 'Следующее бесплатное вращение через {0}', 'الدورة المجانية التالية خلال {0}'],
        ['Free spin ready now!', 'Бесплатное вращение уже доступно!', 'الدورة المجانية جاهزة الآن!'],
        ['🎬 Watch ad & Spin', '🎬 Смотреть рекламу и крутить', '🎬 شاهد الإعلان وأدر العجلة'],
        ['⏳ Next spin in {0}', '⏳ Следующее вращение через {0}', '⏳ الدورة التالية خلال {0}'],
        ['Spinning...', 'Вращение...', 'جارٍ الدوران...'],
        ["Ad isn't available right now. Please try again.", 'Реклама сейчас недоступна. Попробуйте ещё раз.', 'الإعلان غير متاح الآن. حاول مرة أخرى.'],
        ['🎉 You won {0} WTC!', '🎉 Вы выиграли {0} WTC!', '🎉 لقد ربحت {0} WTC!'],

        // ── Profile ──
        ['Total balance', 'Общий баланс', 'إجمالي الرصيد'],
        ['Lifetime earned', 'Заработано за всё время', 'إجمالي ما كسبته'],
        ['Referrals', 'Рефералы', 'الإحالات'],
        ['Tasks completed', 'Выполнено заданий', 'المهام المنجزة'],
        ['User', 'Пользователь', 'مستخدم'],

        // ── Withdraw modal ──
        ['Binance UID', 'Binance UID', 'معرّف Binance'],
        ['Tonkeeper Address', 'Адрес Tonkeeper', 'عنوان Tonkeeper'],
        ['Withdrawals are closed', 'Выводы закрыты', 'السحب مغلق'],
        ["New withdraw requests aren't being accepted right now. Any request you already submitted before this will still be reviewed and paid normally.", 'Новые заявки на вывод сейчас не принимаются. Все ранее отправленные заявки будут рассмотрены и оплачены как обычно.', 'لا يتم قبول طلبات سحب جديدة حاليًا. سيتم مراجعة ودفع أي طلب أرسلته سابقًا بشكل طبيعي.'],
        ['Withdraw WTC', 'Вывод WTC', 'سحب WTC'],
        ['Withdrawing to', 'Вывод на', 'السحب إلى'],
        ['🔒 Locked to your first withdrawal — contact support in the bot if this address is wrong.', '🔒 Привязан к вашему первому выводу — если адрес неверный, обратитесь в поддержку через бота.', '🔒 مرتبط بأول عملية سحب لك — إذا كان العنوان خاطئًا فتواصل مع الدعم عبر البوت.'],
        ['Select gateway', 'Выберите способ вывода', 'اختر طريقة السحب'],
        ['Enter your Binance UID', 'Введите ваш Binance UID', 'أدخل معرّف Binance الخاص بك'],
        ['UQ... wallet address', 'Адрес кошелька UQ...', 'عنوان المحفظة UQ...'],
        ['⚠️ This becomes your permanent withdrawal wallet — double-check it before submitting.', '⚠️ Этот адрес станет вашим постоянным кошельком для вывода — тщательно проверьте его перед отправкой.', '⚠️ سيصبح هذا محفظة السحب الدائمة الخاصة بك — تحقق منه جيدًا قبل الإرسال.'],
        ['Amount (WTC) — minimum {0}', 'Сумма (WTC) — минимум {0}', 'المبلغ (WTC) — الحد الأدنى {0}'],
        ['MAX', 'МАКС', 'الأقصى'],
        ['{0} WTC = 1 USDT · Balance:', '{0} WTC = 1 USDT · Баланс:', '{0} WTC = 1 USDT · الرصيد:'],
        ["Couldn't load — try again.", 'Не удалось загрузить — попробуйте ещё раз.', 'تعذّر التحميل — حاول مرة أخرى.'],
        ['Loading requirements...', 'Загрузка требований...', 'جارٍ تحميل المتطلبات...'],
        ['Complete {0} tasks (one-time)', 'Выполните {0} заданий (один раз)', 'أنجز {0} مهام (مرة واحدة)'],
        ['Watch {0} ads today', 'Посмотрите {0} реклам сегодня', 'شاهد {0} إعلانات اليوم'],
        ['Account at least {0} hours old', 'Аккаунту не менее {0} ч', 'عمر الحساب {0} ساعة على الأقل'],
        ['({0}h left)', '(осталось {0} ч)', '(متبقي {0} ساعة)'],
        ['First withdrawal — free, up to {0} WTC', 'Первый вывод — бесплатно, до {0} WTC', 'أول سحب — مجاني، حتى {0} WTC'],
        ['Valid referrals available', 'Доступно действительных рефералов', 'الإحالات الصالحة المتاحة'],
        ['({0} available, 1 per every ${1})', '(доступно: {0}, 1 на каждые ${1})', '(المتاح: {0}، واحدة لكل ${1})'],
        ['🔑 Buy Valid Referral — {0} TON', '🔑 Купить реферала — {0} TON', '🔑 اشترِ إحالة صالحة — {0} TON'],
        ['You receive', 'Вы получите', 'ستستلم'],
        ['Fees: {0}% + {1}%, taken together at withdraw time.', 'Комиссии: {0}% + {1}%, удерживаются вместе при выводе.', 'الرسوم: {0}% + {1}%، تُخصم معًا وقت السحب.'],
        ['⏱ Withdrawals are paid within {0}–{1} hours after you submit.', '⏱ Выплата производится в течение {0}–{1} ч после отправки заявки.', '⏱ يتم دفع السحب خلال {0} إلى {1} ساعة بعد إرسال الطلب.'],
        ['Minimum {0} WTC', 'Минимум {0} WTC', 'الحد الأدنى {0} WTC'],
        ['Insufficient WTC balance', 'Недостаточно WTC на балансе', 'رصيد WTC غير كافٍ'],
        ['Free first withdrawal capped at {0} WTC', 'Бесплатный первый вывод ограничен {0} WTC', 'أول سحب مجاني محدود بـ {0} WTC'],
        ['Complete requirements above', 'Выполните требования выше', 'أكمل المتطلبات أعلاه'],
        ['Need {0} valid referral{1} (have {2})', 'Нужно действительных рефералов: {0} (есть {2})', 'تحتاج {0} إحالة صالحة (لديك {2})'],
        ['Withdraw {0} WTC', 'Вывести {0} WTC', 'سحب {0} WTC'],
        ['Please enter your address/UID.', 'Пожалуйста, введите адрес/UID.', 'يرجى إدخال العنوان/المعرّف.'],
        ['Please enter an amount.', 'Пожалуйста, введите сумму.', 'يرجى إدخال المبلغ.'],
        ['Submitting...', 'Отправка...', 'جارٍ الإرسال...'],
        ["Withdraw request submitted — you'll be paid within {0}–{1} hours.", 'Заявка на вывод отправлена — выплата в течение {0}–{1} ч.', 'تم إرسال طلب السحب — سيتم الدفع خلال {0}–{1} ساعة.'],

        // ── Wallet double-check (before every withdrawal) ──
        ['Double-check your wallet', 'Проверьте свой кошелёк', 'تحقق من محفظتك جيدًا'],
        ['Your money will be sent to the address below. Check every character — payments sent to a wrong address cannot be recovered.', 'Деньги будут отправлены на адрес ниже. Проверьте каждый символ — платежи на неверный адрес вернуть невозможно.', 'سيتم إرسال أموالك إلى العنوان أدناه. تحقق من كل حرف — لا يمكن استرجاع المدفوعات المرسلة إلى عنوان خاطئ.'],
        ['Method', 'Способ', 'الطريقة'],
        ['Address / UID', 'Адрес / UID', 'العنوان / المعرّف'],
        ['I have carefully checked my wallet address and it is correct.', 'Я внимательно проверил(а) адрес кошелька, он верный.', 'لقد تحققت من عنوان محفظتي بعناية وهو صحيح.'],
        ['Confirm & Withdraw', 'Подтвердить и вывести', 'تأكيد وسحب'],
        ['Go back', 'Назад', 'رجوع'],

        // ── Buy valid referral (Punch Key) ──
        ['🔑 Buy Valid Referral', '🔑 Купить реферала', '🔑 اشترِ إحالة صالحة'],
        ['Limit reached', 'Лимит достигнут', 'تم بلوغ الحد الأقصى'],
        ["You've already bought the maximum of {0} valid referrals this way. Refer real friends to unlock more.", 'Вы уже купили максимум ({0}) действительных рефералов таким способом. Приглашайте реальных друзей, чтобы получить больше.', 'لقد اشتريت الحد الأقصى ({0}) من الإحالات الصالحة بهذه الطريقة. ادعُ أصدقاء حقيقيين لفتح المزيد.'],
        ['Pay {0} TON to instantly unlock 1 valid referral — no need to wait for someone to sign up.', 'Оплатите {0} TON и мгновенно получите 1 действительного реферала — не нужно ждать чьей-то регистрации.', 'ادفع {0} TON لفتح إحالة صالحة واحدة فورًا — دون انتظار تسجيل أحد.'],
        ['{0}/{1} purchased · {2} left', 'Куплено {0}/{1} · осталось {2}', 'تم شراء {0}/{1} · المتبقي {2}'],
        ['{0} copied!', '{0}: скопировано!', 'تم نسخ {0}!'],
        ['Amount', 'Сумма', 'المبلغ'],
        ['Send to this address', 'Отправьте на этот адрес', 'أرسل إلى هذا العنوان'],
        ['Copy', 'Копировать', 'نسخ'],
        ['Comment / Memo —', 'Комментарий / Memo —', 'التعليق / Memo —'],
        ['must include exactly', 'должен быть указан точно', 'يجب إدراجه كما هو تمامًا'],
        ["⚠️ Without this exact comment, we can't tell the payment is yours and it won't be credited automatically.", '⚠️ Без этого точного комментария мы не сможем определить, что платёж ваш, и он не будет зачислен автоматически.', '⚠️ بدون هذا التعليق بالضبط لن نتمكن من معرفة أن الدفعة لك ولن تُضاف تلقائيًا.'],
        ['Open in Tonkeeper', 'Открыть в Tonkeeper', 'افتح في Tonkeeper'],
        ['Waiting for payment...', 'Ожидание оплаты...', 'بانتظار الدفع...'],
        ['Cancel order', 'Отменить заказ', 'إلغاء الطلب'],
        ['Order cancelled.', 'Заказ отменён.', 'تم إلغاء الطلب.'],
        ['Expired', 'Истёк', 'انتهت المهلة'],
        ['Auto-cancels in {0} if unpaid', 'Автоотмена через {0}, если не оплачено', 'يُلغى تلقائيًا خلال {0} إن لم يتم الدفع'],
        ['+1 Valid Referral', '+1 действительный реферал', '+1 إحالة صالحة'],
        ['Valid referral unlocked!', 'Действительный реферал получен!', 'تم فتح إحالة صالحة!'],
        ['Order expired', 'Срок заказа истёк', 'انتهت صلاحية الطلب'],
        ['No payment was received within {0} minutes.', 'Оплата не поступила в течение {0} мин.', 'لم يتم استلام أي دفعة خلال {0} دقيقة.'],

        // ── Video ──
        ['Watch videos, earn WTC', 'Смотрите видео — зарабатывайте WTC', 'شاهد الفيديوهات واكسب WTC'],
        ['No videos available yet.', 'Видео пока нет.', 'لا توجد فيديوهات متاحة بعد.'],
        ['⚡ 60 WTC/hr', '⚡ 60 WTC/ч', '⚡ 60 WTC/ساعة'],
        ['Claim me!', 'Забери меня!', 'استلمني!'],
        ['You need at least 25 WTC to claim (currently {0}).', 'Для получения нужно минимум 25 WTC (сейчас {0}).', 'تحتاج إلى 25 WTC على الأقل للاستلام (لديك حاليًا {0}).'],
        ['+{0} WTC added to your balance!', '+{0} WTC добавлено на ваш баланс!', 'تمت إضافة +{0} WTC إلى رصيدك!'],
        ['Earned this session', 'Заработано за сессию', 'المكتسب في هذه الجلسة'],
        ['60 WTC earned per hour watched', '60 WTC за каждый час просмотра', '60 WTC مقابل كل ساعة مشاهدة'],
        ['50 WTC earned per hour watched', '50 WTC за каждый час просмотра', '50 WTC مقابل كل ساعة مشاهدة'],
        ['Paused — claim your lootbox to resume earning', 'Пауза — заберите лутбокс, чтобы продолжить зарабатывать', 'متوقف مؤقتًا — استلم الصندوق لمواصلة الربح'],
        ['🎁 Lootbox full — go claim it to keep earning!', '🎁 Лутбокс заполнен — заберите его, чтобы продолжить зарабатывать!', '🎁 الصندوق ممتلئ — استلمه لمواصلة الربح!'],
        ['🎁 Your lootbox is full — claim it to keep earning!', '🎁 Ваш лутбокс заполнен — заберите его, чтобы продолжить зарабатывать!', '🎁 صندوقك ممتلئ — استلمه لمواصلة الربح!'],
        ['Up next', 'Далее', 'التالي'],
        ['No other videos yet.', 'Других видео пока нет.', 'لا توجد فيديوهات أخرى بعد.'],

        // ── Earning (ads) ──
        ['Watch ads to earn', 'Смотрите рекламу — зарабатывайте', 'شاهد الإعلانات واكسب'],
        ['Each network has its own daily limit — watch them all for maximum earnings.', 'У каждой сети свой дневной лимит — смотрите все, чтобы заработать максимум.', 'لكل شبكة حد يومي خاص بها — شاهدها جميعًا لتحقيق أقصى ربح.'],
        ['Today:', 'Сегодня:', 'اليوم:'],
        ['{0}/{1} today', '{0}/{1} сегодня', '{0}/{1} اليوم'],
        ['Coming soon — will be enabled once ads are approved', 'Скоро — включим после одобрения рекламы', 'قريبًا — سيتم التفعيل بعد الموافقة على الإعلانات'],
        ['Coming Soon', 'Скоро', 'قريبًا'],
        ['Done', 'Готово', 'تم'],
        ['Watch', 'Смотреть', 'شاهد'],
        ['Special Ads', 'Спецреклама', 'إعلانات خاصة'],
        ['Adsgram Daily', 'Adsgram ежедневно', 'Adsgram اليومي'],
        ['Loading {0} ad...', 'Загрузка рекламы {0}...', 'جارٍ تحميل إعلان {0}...'],
        ["{0} ad isn't available right now. Please try again or pick a different network.", 'Реклама {0} сейчас недоступна. Попробуйте ещё раз или выберите другую сеть.', 'إعلان {0} غير متاح الآن. حاول مرة أخرى أو اختر شبكة أخرى.'],
        ['+{0} WTC added! ({1}/{2})', '+{0} WTC добавлено! ({1}/{2})', 'تمت إضافة +{0} WTC! ({1}/{2})'],
        ["This ad isn't available right now. Please try again.", 'Эта реклама сейчас недоступна. Попробуйте ещё раз.', 'هذا الإعلان غير متاح الآن. حاول مرة أخرى.'],

        // ── Tasks ──
        ['Complete tasks, earn WTC', 'Выполняйте задания — зарабатывайте WTC', 'أنجز المهام واكسب WTC'],
        ['📋 Create Task — publish your own', '📋 Создать задание — опубликуйте своё', '📋 إنشاء مهمة — انشر مهمتك الخاصة'],
        ['⭐ Exclusive', '⭐ Эксклюзив', '⭐ حصرية'],
        ['🤝 Partner', '🤝 Партнёры', '🤝 الشركاء'],
        ['👥 Earning', '👥 Заработок', '👥 الأرباح'],
        ['No tasks in this category right now — check back later.', 'В этой категории сейчас нет заданий — загляните позже.', 'لا توجد مهام في هذه الفئة الآن — عد لاحقًا.'],
        ['✓ Verified', '✓ Проверено', '✓ موثّق'],
        ['Daily', 'Ежедневно', 'يومي'],
        ['Exclusive', 'Эксклюзив', 'حصري'],
        ['Partner', 'Партнёр', 'شريك'],
        ['Start', 'Начать', 'ابدأ'],
        ['After joining the channel/group, tap Verify below. Our server will check your membership.', 'После вступления в канал/группу нажмите «Проверить» ниже. Наш сервер проверит вашу подписку.', 'بعد الانضمام إلى القناة/المجموعة اضغط «تحقق» أدناه. سيتحقق خادمنا من عضويتك.'],
        ['After completing the task above, tap Claim to receive your reward.', 'После выполнения задания нажмите «Получить», чтобы забрать награду.', 'بعد إنجاز المهمة أعلاه اضغط «استلام» للحصول على مكافأتك.'],
        ['✅ Verify Membership', '✅ Проверить подписку', '✅ تحقق من العضوية'],
        ['🎁 Claim in {0}s', '🎁 Получить через {0} с', '🎁 استلم خلال {0} ث'],
        ['🎁 Claim Reward', '🎁 Получить награду', '🎁 استلم المكافأة'],
        ['You already completed this task.', 'Вы уже выполнили это задание.', 'لقد أنجزت هذه المهمة بالفعل.'],
        ['Not a member yet — join first, then verify.', 'Вы ещё не участник — сначала вступите, затем проверьте.', 'لست عضوًا بعد — انضم أولاً ثم تحقق.'],

        // ── Create task ──
        ['📋 Create Task', '📋 Создать задание', '📋 إنشاء مهمة'],
        ['Pay TON to submit your own task for admin review — once approved, it goes live in the ⭐ Exclusive section and other users complete it for {0} WTC each.', 'Оплатите TON, чтобы отправить своё задание на проверку администратору — после одобрения оно появится в разделе ⭐ Эксклюзив, и другие пользователи будут выполнять его за {0} WTC каждый.', 'ادفع TON لإرسال مهمتك إلى مراجعة المشرف — بعد الموافقة تظهر في قسم ⭐ حصرية ويُنجزها المستخدمون الآخرون مقابل {0} WTC لكل منهم.'],
        ['+ Create New Task', '+ Создать новое задание', '+ إنشاء مهمة جديدة'],
        ["You haven't created any tasks yet.", 'Вы ещё не создали ни одного задания.', 'لم تنشئ أي مهام بعد.'],
        ['❌ Rejected', '❌ Отклонено', '❌ مرفوض'],
        ['⏳ Pending Review', '⏳ На проверке', '⏳ قيد المراجعة'],
        ['📋 New Task', '📋 Новое задание', '📋 مهمة جديدة'],
        ['Task type', 'Тип задания', 'نوع المهمة'],
        ['📢 Channel/Group Join', '📢 Вступление в канал/группу', '📢 الانضمام إلى قناة/مجموعة'],
        ['🔗 Link (Bot/Website)', '🔗 Ссылка (бот/сайт)', '🔗 رابط (بوت/موقع)'],
        ['Channel/Group username', 'Username канала/группы', 'اسم مستخدم القناة/المجموعة'],
        ['⚠️ NEWTUBE bot must be an ADMIN in this channel/group, or membership can never be verified and users won\'t be able to complete this task — your TON payment is non-refundable either way.', '⚠️ Бот NEWTUBE должен быть АДМИНИСТРАТОРОМ этого канала/группы, иначе подписку невозможно проверить и пользователи не смогут выполнить задание — оплата в TON в любом случае не возвращается.', '⚠️ يجب أن يكون بوت NEWTUBE مشرفًا في هذه القناة/المجموعة، وإلا لن يمكن التحقق من العضوية ولن يتمكن المستخدمون من إنجاز المهمة — ولا يمكن استرداد دفعة TON في كل الأحوال.'],
        ['Link (Telegram bot or website)', 'Ссылка (Telegram-бот или сайт)', 'رابط (بوت تيليجرام أو موقع)'],
        ['Task title', 'Название задания', 'عنوان المهمة'],
        ['e.g. Join our channel', 'напр., Вступите в наш канал', 'مثال: انضم إلى قناتنا'],
        ['How many people can complete it?', 'Сколько человек смогут его выполнить?', 'كم شخصًا يمكنه إنجازها؟'],
        ['{0} tasks', '{0} заданий', '{0} مهمة'],
        ['Each completion pays the user {0} WTC.', 'За каждое выполнение пользователь получает {0} WTC.', 'كل إنجاز يمنح المستخدم {0} WTC.'],
        ['Continue to Payment', 'Перейти к оплате', 'المتابعة إلى الدفع'],
        ['← Back', '← Назад', '→ رجوع'],
        ['Please enter a task title.', 'Пожалуйста, введите название задания.', 'يرجى إدخال عنوان المهمة.'],
        ['Please enter a channel/group username.', 'Пожалуйста, введите username канала/группы.', 'يرجى إدخال اسم مستخدم القناة/المجموعة.'],
        ['Please enter a link.', 'Пожалуйста, введите ссылку.', 'يرجى إدخال رابط.'],
        ['Creating order...', 'Создание заказа...', 'جارٍ إنشاء الطلب...'],
        ['💳 Pay to Publish', '💳 Оплата публикации', '💳 ادفع للنشر'],
        ['{0} people will be able to complete this task.', 'Это задание смогут выполнить {0} человек.', 'سيتمكن {0} شخصًا من إنجاز هذه المهمة.'],
        ["⚠️ Without this exact comment, we can't tell the payment is yours and your task won't be published automatically.", '⚠️ Без этого точного комментария мы не сможем определить, что платёж ваш, и задание не будет опубликовано автоматически.', '⚠️ بدون هذا التعليق بالضبط لن نتمكن من معرفة أن الدفعة لك ولن تُنشر مهمتك تلقائيًا.'],
        ['Address copied!', 'Адрес скопирован!', 'تم نسخ العنوان!'],
        ['Memo copied!', 'Memo скопирован!', 'تم نسخ Memo!'],
        ['Payment Confirmed!', 'Оплата подтверждена!', 'تم تأكيد الدفع!'],
        ['Payment confirmed — your task is now pending admin review.', 'Оплата подтверждена — ваше задание ожидает проверки администратора.', 'تم تأكيد الدفع — مهمتك الآن قيد مراجعة المشرف.'],

        // ── Refer tab ──
        ['Total bonus per friend', 'Общий бонус за друга', 'إجمالي المكافأة لكل صديق'],
        ['💰 + 10% of everything they withdraw, forever', '💰 + 10% от всего, что они выводят, навсегда', '💰 + 10% من كل ما يسحبونه، إلى الأبد'],
        ['🔗 Share Now', '🔗 Поделиться', '🔗 شارك الآن'],
        ['Copy Link', 'Копировать ссылку', 'نسخ الرابط'],
        ['Link copied!', 'Ссылка скопирована!', 'تم نسخ الرابط!'],
        ['Total referrals', 'Всего рефералов', 'إجمالي الإحالات'],
        ['Referral earnings', 'Заработок с рефералов', 'أرباح الإحالات'],
        ['💰 Withdrawal commission', '💰 Комиссия с выводов', '💰 عمولة السحب'],
        ['10% of every withdrawal your referrals make — for as long as they keep withdrawing.', '10% от каждого вывода ваших рефералов — пока они продолжают выводить средства.', '10% من كل عملية سحب يجريها المُحالون — طالما استمروا في السحب.'],
        ['How the bonus works', 'Как работает бонус', 'كيف تعمل المكافأة'],
        ['Friend joins channel + community and verifies', 'Друг вступает в канал и сообщество и проходит проверку', 'ينضم الصديق إلى القناة والمجتمع ويتحقق'],
        ['Friend completes 5 tasks', 'Друг выполняет 5 заданий', 'يُنجز الصديق 5 مهام'],
        ['Friend watches 20 ads', 'Друг смотрит 20 реклам', 'يشاهد الصديق 20 إعلانًا'],
        ['Friend claims their first Video lootbox', 'Друг забирает свой первый лутбокс в разделе «Видео»', 'يستلم الصديق أول صندوق فيديو له'],
        ['Every time they withdraw, after that', 'Каждый раз, когда они выводят средства, далее', 'في كل مرة يسحبون فيها بعد ذلك'],
        ['✅ When does a referral become "valid"?', '✅ Когда реферал становится «действительным»?', '✅ متى تصبح الإحالة «صالحة»؟'],
        ["A referral counts toward your withdrawals once your friend has completed both — 5 tasks and 20 ads (doesn't matter which order). Joining the channel alone, or just one of the two, isn't enough yet.", 'Реферал засчитывается для ваших выводов, когда друг выполнил оба условия — 5 заданий и 20 реклам (порядок не важен). Одного вступления в канал или только одного из двух условий пока недостаточно.', 'تُحتسب الإحالة لعمليات سحبك عندما يُكمل صديقك الأمرين معًا — 5 مهام و20 إعلانًا (بأي ترتيب). الانضمام إلى القناة وحده، أو أحد الأمرين فقط، لا يكفي بعد.'],

        // ── Error / device / ban screens ──
        ['Connection Problem', 'Проблема с подключением', 'مشكلة في الاتصال'],
        ["Couldn't reach the server — your connection might be slow or unstable right now.", 'Не удалось связаться с сервером — возможно, соединение медленное или нестабильное.', 'تعذّر الوصول إلى الخادم — قد يكون اتصالك بطيئًا أو غير مستقر الآن.'],
        ['Device Already In Use', 'Устройство уже используется', 'الجهاز مستخدم بالفعل'],
        ['This device is already linked to another account.', 'Это устройство уже привязано к другому аккаунту.', 'هذا الجهاز مرتبط بالفعل بحساب آخر.'],
        ['Log in with that account, or claim this device for this one below.', 'Войдите в тот аккаунт или привяжите это устройство к текущему ниже.', 'سجّل الدخول بذلك الحساب، أو انقل هذا الجهاز إلى هذا الحساب من الأسفل.'],
        ['Unknown user', 'Неизвестный пользователь', 'مستخدم غير معروف'],
        ['Switch account (resets my balance)', 'Сменить аккаунт (обнулит мой баланс)', 'تبديل الحساب (يصفّر رصيدي)'],
        ['Switching claims this connection for your account but resets your WTC and USDT balance to zero.', 'При смене это соединение закрепляется за вашим аккаунтом, но баланс WTC и USDT обнуляется.', 'يؤدي التبديل إلى ربط هذا الاتصال بحسابك لكنه يصفّر رصيد WTC وUSDT الخاص بك.'],
        ['Switching…', 'Переключение…', 'جارٍ التبديل…'],
        ['This will reset your entire balance to zero. Continue?', 'Это обнулит весь ваш баланс. Продолжить?', 'سيؤدي هذا إلى تصفير رصيدك بالكامل. هل تريد المتابعة؟'],
        ['Could not switch account', 'Не удалось сменить аккаунт', 'تعذّر تبديل الحساب'],
        ['Account Banned', 'Аккаунт заблокирован', 'تم حظر الحساب'],
        ['Your account has been banned for breaking our rules (multiple accounts or cheating).', 'Ваш аккаунт заблокирован за нарушение правил (несколько аккаунтов или обман).', 'تم حظر حسابك لمخالفة قواعدنا (حسابات متعددة أو غش).'],
        ['If you believe this is a mistake, tap below to request a review from the admin.', 'Если вы считаете, что это ошибка, нажмите ниже, чтобы запросить проверку у администратора.', 'إذا كنت تعتقد أن هذا خطأ، فاضغط أدناه لطلب مراجعة من المشرف.'],
        ['🆘 Request Review', '🆘 Запросить проверку', '🆘 اطلب مراجعة'],
        ['Open this in Telegram', 'Откройте в Telegram', 'افتح هذا في تيليجرام'],
        ['NEWTUBE only works inside the Telegram app. Please open it via the NEWTUBE bot.', 'NEWTUBE работает только внутри Telegram. Откройте его через бота NEWTUBE.', 'يعمل NEWTUBE داخل تطبيق تيليجرام فقط. يرجى فتحه عبر بوت NEWTUBE.'],

        // ── Error messages (toasts) ──
        ['Minimum amount not reached yet.', 'Минимальная сумма ещё не достигнута.', 'لم يتم بلوغ الحد الأدنى للمبلغ بعد.'],
        ["Today's limit reached — come back tomorrow.", 'Лимит на сегодня исчерпан — возвращайтесь завтра.', 'تم بلوغ حد اليوم — عد غدًا.'],
        ["No spins left right now — come back in a bit, or invite a friend for a bonus spin!", 'Сейчас вращений нет — загляните чуть позже или пригласите друга и получите бонусное вращение!', 'لا توجد دورات متاحة الآن — عد بعد قليل، أو ادعُ صديقًا للحصول على دورة إضافية!'],
        ['Daily 5-hour video watch limit reached.', 'Достигнут дневной лимит просмотра видео — 5 часов.', 'تم بلوغ حد مشاهدة الفيديو اليومي — 5 ساعات.'],
        ['🎁 Claim your lootbox before earning more!', '🎁 Заберите лутбокс, прежде чем зарабатывать дальше!', '🎁 استلم صندوقك قبل أن تربح المزيد!'],
        ['This video session was already claimed.', 'Эта видеосессия уже получена.', 'تم استلام جلسة الفيديو هذه بالفعل.'],
        ['Please watch an ad first.', 'Сначала посмотрите рекламу.', 'يرجى مشاهدة إعلان أولاً.'],
        ['Insufficient balance.', 'Недостаточно средств.', 'الرصيد غير كافٍ.'],
        ['Watch {0} ads today before withdrawing.', 'Посмотрите {0} реклам сегодня, прежде чем выводить средства.', 'شاهد {0} إعلانات اليوم قبل السحب.'],
        ['Complete at least {0} tasks (lifetime, one-time) before you can withdraw.', 'Выполните не менее {0} заданий (за всё время, один раз), прежде чем выводить средства.', 'أنجز {0} مهام على الأقل (مرة واحدة طوال الحساب) قبل أن تتمكن من السحب.'],
        ['This ad network is coming soon — not available yet.', 'Эта рекламная сеть скоро появится — пока недоступна.', 'شبكة الإعلانات هذه قادمة قريبًا — غير متاحة بعد.'],
        ['Please reopen the task and try again.', 'Пожалуйста, откройте задание заново и повторите попытку.', 'يرجى إعادة فتح المهمة والمحاولة مرة أخرى.'],
        ["Hold on a moment — you're claiming this a bit too fast.", 'Подождите немного — вы забираете награду слишком быстро.', 'انتظر لحظة — أنت تستلم بسرعة كبيرة.'],
        ['This task took too long to claim — please reopen it.', 'Слишком много времени прошло — откройте задание заново.', 'استغرق استلام هذه المهمة وقتًا طويلًا — يرجى إعادة فتحها.'],
        ['This task was already claimed.', 'Это задание уже выполнено.', 'تم استلام هذه المهمة بالفعل.'],
        ['This task has reached its completion limit.', 'Это задание достигло лимита выполнений.', 'وصلت هذه المهمة إلى حد الإنجاز.'],
        ["You're moving between tasks a bit too fast — please wait a few seconds before claiming another.", 'Вы переходите между заданиями слишком быстро — подождите несколько секунд перед следующим.', 'أنت تنتقل بين المهام بسرعة كبيرة — انتظر بضع ثوانٍ قبل استلام مهمة أخرى.'],
        ['Your first withdrawal was free — every withdrawal after that needs valid referrals (1 per every $0.25 withdrawn).', 'Первый вывод был бесплатным — каждый следующий требует действительных рефералов (1 на каждые $0.25).', 'كان أول سحب مجانيًا — كل سحب بعده يتطلب إحالات صالحة (واحدة لكل $0.25 يتم سحبها).'],
        ["You've reached the maximum of {0} Punch Key purchases — refer real friends to unlock more valid referrals.", 'Вы достигли максимума ({0}) покупок Punch Key — приглашайте реальных друзей, чтобы получить больше действительных рефералов.', 'لقد بلغت الحد الأقصى ({0}) من مشتريات Punch Key — ادعُ أصدقاء حقيقيين لفتح المزيد من الإحالات الصالحة.'],
        ['You already have a withdrawal request being processed. Please wait for it to be approved or rejected.', 'У вас уже есть заявка на вывод в обработке. Дождитесь её одобрения или отклонения.', 'لديك طلب سحب قيد المعالجة بالفعل. يرجى انتظار الموافقة عليه أو رفضه.'],
        ['Minimum {0} WTC required to withdraw.', 'Для вывода нужно минимум {0} WTC.', 'يلزم {0} WTC على الأقل للسحب.'],
        ['You already withdrew today — try again tomorrow.', 'Вы уже выводили средства сегодня — попробуйте завтра.', 'لقد سحبت اليوم بالفعل — حاول غدًا.'],
        ['This address is already used by another account.', 'Этот адрес уже используется другим аккаунтом.', 'هذا العنوان مستخدم بالفعل من قبل حساب آخر.'],
        ['Your account has been suspended.', 'Ваш аккаунт заблокирован.', 'تم تعليق حسابك.'],
        ['Please join the channel/group first.', 'Сначала вступите в канал/группу.', 'يرجى الانضمام إلى القناة/المجموعة أولاً.'],
        ['Invalid code — please type it in manually rather than copy-pasting.', 'Неверный код — введите его вручную, а не копируйте.', 'رمز غير صالح — يرجى كتابته يدويًا بدلًا من النسخ واللصق.'],
        ['You already used this code.', 'Вы уже использовали этот код.', 'لقد استخدمت هذا الرمز بالفعل.'],
        ['This code has reached its usage limit.', 'Этот код достиг лимита использований.', 'وصل هذا الرمز إلى حد الاستخدام.'],
        ['This code has expired.', 'Срок действия этого кода истёк.', 'انتهت صلاحية هذا الرمز.'],
        ['This task has reached its quota.', 'Это задание достигло своей квоты.', 'وصلت هذه المهمة إلى حصتها.'],
        ['Please try again in a moment.', 'Пожалуйста, повторите через мгновение.', 'يرجى المحاولة مرة أخرى بعد قليل.'],
        ['Server error, please try again shortly.', 'Ошибка сервера, повторите попытку чуть позже.', 'خطأ في الخادم، يرجى المحاولة بعد قليل.'],
        ['Video earning is temporarily unavailable — please try again later.', 'Заработок на видео временно недоступен — попробуйте позже.', 'الربح من الفيديو غير متاح مؤقتًا — حاول لاحقًا.'],
        ['Session expired — please reopen the app from Telegram.', 'Сессия истекла — откройте приложение из Telegram заново.', 'انتهت الجلسة — يرجى إعادة فتح التطبيق من تيليجرام.'],
        ['Your account is under review — join the channel & community to unlock earning.', 'Ваш аккаунт на проверке — вступите в канал и сообщество, чтобы открыть заработок.', 'حسابك قيد المراجعة — انضم إلى القناة والمجتمع لفتح الربح.'],
        ['Withdrawals are currently closed. Any previously submitted request will still be processed.', 'Выводы сейчас закрыты. Ранее отправленные заявки всё равно будут обработаны.', 'السحب مغلق حاليًا. سيتم تنفيذ أي طلب أُرسل سابقًا.'],
        ['Ad failed to load — please try again.', 'Не удалось загрузить рекламу — попробуйте ещё раз.', 'فشل تحميل الإعلان — حاول مرة أخرى.'],
        ['Ad timed out — please try again.', 'Время ожидания рекламы истекло — попробуйте ещё раз.', 'انتهت مهلة الإعلان — حاول مرة أخرى.'],
        ['Please tap "Watch" again to load the ad properly.', 'Нажмите «Смотреть» ещё раз, чтобы реклама загрузилась правильно.', 'اضغط «شاهد» مرة أخرى لتحميل الإعلان بشكل صحيح.'],
        ['Ad session invalid — please tap "Watch" again.', 'Сессия рекламы недействительна — нажмите «Смотреть» ещё раз.', 'جلسة الإعلان غير صالحة — اضغط «شاهد» مرة أخرى.'],
        ['Please watch the full ad before claiming the reward.', 'Досмотрите рекламу до конца, прежде чем забирать награду.', 'يرجى مشاهدة الإعلان كاملًا قبل استلام المكافأة.'],
        ['This ad session expired — please tap "Watch" again.', 'Сессия рекламы истекла — нажмите «Смотреть» ещё раз.', 'انتهت جلسة الإعلان — اضغط «شاهد» مرة أخرى.'],
        ['Video session expired — resuming...', 'Сессия видео истекла — возобновляем...', 'انتهت جلسة الفيديو — جارٍ الاستئناف...'],
        ['This ad was already claimed.', 'Награда за эту рекламу уже получена.', 'تم استلام مكافأة هذا الإعلان بالفعل.'],
        ['Unknown ad network — please refresh the app.', 'Неизвестная рекламная сеть — обновите приложение.', 'شبكة إعلانات غير معروفة — يرجى تحديث التطبيق.'],
        ['Ad rewards are temporarily unavailable — please try again later.', 'Награды за рекламу временно недоступны — попробуйте позже.', 'مكافآت الإعلانات غير متاحة مؤقتًا — حاول لاحقًا.'],
        ['This order was not found — please start again.', 'Заказ не найден — начните заново.', 'لم يتم العثور على هذا الطلب — ابدأ من جديد.'],
        ['Something went wrong — please try again.', 'Что-то пошло не так — попробуйте ещё раз.', 'حدث خطأ ما — يرجى المحاولة مرة أخرى.'],
        ['Could not find your account — please reopen the app.', 'Не удалось найти ваш аккаунт — откройте приложение заново.', 'تعذّر العثور على حسابك — يرجى إعادة فتح التطبيق.'],
        ['Please select a valid package.', 'Выберите корректный пакет.', 'يرجى اختيار باقة صالحة.'],
        ['Task title is too long — please shorten it.', 'Название задания слишком длинное — сократите его.', 'عنوان المهمة طويل جدًا — يرجى تقصيره.'],
        ['Please enter a valid link starting with http:// or https://', 'Введите корректную ссылку, начинающуюся с http:// или https://', 'يرجى إدخال رابط صالح يبدأ بـ http:// أو https://'],
        ['Something went wrong, please try again.', 'Что-то пошло не так, попробуйте ещё раз.', 'حدث خطأ ما، يرجى المحاولة مرة أخرى.'],
        ['Please accept the Terms & Conditions first.', 'Сначала примите Условия использования.', 'يرجى قبول الشروط والأحكام أولاً.'],
        ['The terms were updated — please reopen the app.', 'Условия обновлены — откройте приложение заново.', 'تم تحديث الشروط — يرجى إعادة فتح التطبيق.'],
        ['Your account is too new for its first withdrawal — please wait until it is old enough.', 'Ваш аккаунт ещё слишком новый для первого вывода — подождите.', 'حسابك جديد جدًا لأول سحب — يرجى الانتظار.'],
        ['Your account is temporarily locked for review. Please contact support.', 'Ваш аккаунт временно заблокирован на время проверки. Обратитесь в поддержку.', 'حسابك مقفل مؤقتًا للمراجعة. يرجى التواصل مع الدعم.'],
        ['Your free first withdrawal is capped — please lower the amount.', 'Бесплатный первый вывод ограничен — уменьшите сумму.', 'أول سحب مجاني محدود — يرجى تقليل المبلغ.'],
        ['Please enter a valid amount.', 'Введите корректную сумму.', 'يرجى إدخال مبلغ صالح.'],
        ['Could not process the withdrawal — please refresh and try again.', 'Не удалось обработать вывод — обновите страницу и повторите попытку.', 'تعذّرت معالجة السحب — يرجى التحديث والمحاولة مرة أخرى.'],

        // ── Server messages that reach the toast directly (api/withdraw.js, api/earn.js, api/user.js) ──
        ['Your account must be at least {0} hours old before your first withdrawal. Please wait {1} more hour{2}.', 'Аккаунту должно быть не менее {0} ч до первого вывода. Подождите ещё {1} ч.', 'يجب أن يكون عمر حسابك {0} ساعة على الأقل قبل أول سحب. يرجى الانتظار {1} ساعة إضافية.'],
        ['Complete at least {0} tasks (lifetime, one-time) before you can withdraw (you have {1} done).', 'Выполните не менее {0} заданий (за всё время, один раз), прежде чем выводить средства (выполнено: {1}).', 'أنجز {0} مهام على الأقل (مرة واحدة طوال الحساب) قبل السحب (أنجزت {1}).'],
        ['Watch {0} ads today before withdrawing (you have {1} today).', 'Посмотрите {0} реклам сегодня, прежде чем выводить средства (просмотрено: {1}).', 'شاهد {0} إعلانات اليوم قبل السحب (شاهدت {1} اليوم).'],
        ['You need {0} WTC to withdraw this amount.', 'Для вывода этой суммы нужно {0} WTC.', 'تحتاج إلى {0} WTC لسحب هذا المبلغ.'],
        ['Your free first withdrawal is capped at {0} WTC (~${1}). Lower the amount, or refer a friend and wait for them to complete all 3 referral steps to unlock larger withdrawals.', 'Бесплатный первый вывод ограничен {0} WTC (~${1}). Уменьшите сумму или пригласите друга и дождитесь, пока он выполнит все 3 шага, чтобы открыть более крупные выводы.', 'أول سحب مجاني محدود بـ {0} WTC (~${1}). قلّل المبلغ، أو ادعُ صديقًا وانتظر حتى يُكمل خطوات الإحالة الثلاث لفتح سحوبات أكبر.'],
        ['Your first withdrawal was free. Every withdrawal after that needs 1 valid referral per every ${0} withdrawn — this withdrawal needs {1}, you have {2}. Refer a friend and wait for them to complete all 3 referral steps.', 'Первый вывод был бесплатным. Каждый следующий требует 1 действительного реферала на каждые ${0} — для этого вывода нужно {1}, у вас {2}. Пригласите друга и дождитесь, пока он выполнит все 3 шага.', 'كان أول سحب مجانيًا. كل سحب بعده يتطلب إحالة صالحة واحدة لكل ${0} — هذا السحب يحتاج {1} ولديك {2}. ادعُ صديقًا وانتظر حتى يُكمل خطوات الإحالة الثلاث.'],
        ['You already have a withdrawal request being processed. Please wait for it to be approved or rejected before submitting another.', 'У вас уже есть заявка на вывод в обработке. Дождитесь её одобрения или отклонения, прежде чем отправлять новую.', 'لديك طلب سحب قيد المعالجة بالفعل. يرجى انتظار الموافقة عليه أو رفضه قبل إرسال طلب آخر.'],
        ['Could not process the withdrawal — your balance, ad/task progress, or referral status may have changed. Please refresh and try again.', 'Не удалось обработать вывод — возможно, изменился ваш баланс, прогресс по рекламе/заданиям или статус рефералов. Обновите страницу и повторите попытку.', 'تعذّرت معالجة السحب — ربما تغيّر رصيدك أو تقدمك في الإعلانات/المهام أو حالة الإحالات. يرجى التحديث والمحاولة مرة أخرى.'],
        ['Minimum {0} WTC required.', 'Требуется минимум {0} WTC.', 'يلزم {0} WTC على الأقل.'],
        ['This device was already switched recently. Try again in about {0}h, or log into the existing account instead.', 'Это устройство недавно уже переключали. Повторите примерно через {0} ч или войдите в существующий аккаунт.', 'تم تبديل هذا الجهاز مؤخرًا. حاول مرة أخرى بعد حوالي {0} ساعة، أو سجّل الدخول بالحساب الحالي.'],
    ];

    // ── engine ─────────────────────────────────────────────────────────────
    function norm(s) { return s.replace(/\s+/g, ' ').trim(); }
    function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    var EXACT = { ru: Object.create(null), ar: Object.create(null) };
    var PATTERNS = { ru: [], ar: [] };
    DICTIONARY.forEach(function (row) {
        var en = norm(row[0]);
        ['ru', 'ar'].forEach(function (code, i) {
            var out = row[i + 1];
            // Arabic: an en-dash between two numbers renders reversed in RTL text, so write ranges as "{0} إلى {1}".
            if (code === 'ar') out = out.replace(/\{0\}–\{1\}/g, '{0} إلى {1}');
            if (/\{\d+\}/.test(en)) {
                var re = new RegExp('^' + esc(en).replace(/\\\{(\d+)\\\}/g, '(.*?)') + '$', 's');
                PATTERNS[code].push({ re: re, out: out, weight: en.replace(/\{\d+\}/g, '').length });
            } else {
                EXACT[code][en] = out;
            }
        });
    });
    ['ru', 'ar'].forEach(function (c) { PATTERNS[c].sort(function (a, b) { return b.weight - a.weight; }); });

    function fill(tpl, m) { return tpl.replace(/\{(\d+)\}/g, function (_, n) { return m[+n + 1] !== undefined ? m[+n + 1] : ''; }); }

    // Translate one English string to `code`. Returns the same string if unknown.
    function tr(text, code) {
        if (code === 'en' || !EXACT[code]) return text;
        var key = norm(text);
        if (!key || !/[A-Za-z]/.test(key)) return text;
        var hit = EXACT[code][key];
        if (hit !== undefined) return hit;
        var list = PATTERNS[code];
        for (var i = 0; i < list.length; i++) {
            var m = list[i].re.exec(key);
            if (m) return fill(list[i].out, m);
        }
        return text;
    }

    // ── state ──
    var current = 'en';
    function detect() {
        try { var saved = localStorage.getItem(STORAGE_KEY); if (saved && LANGS[saved]) return saved; } catch (e) { /* storage blocked */ }
        try {
            var lc = (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user && window.Telegram.WebApp.initDataUnsafe.user.language_code) || navigator.language || 'en';
            lc = String(lc).toLowerCase().slice(0, 2);
            if (lc === 'ru') return 'ru';
            if (lc === 'ar') return 'ar';
        } catch (e) { /* ignore */ }
        return 'en';
    }

    // ── DOM translation ──
    var TEXT_ORIG = new WeakMap();   // Text node  → { src, out }
    var ATTR_ORIG = new WeakMap();   // Element    → { attr: { src, out } }
    var ATTRS = ['placeholder', 'title', 'aria-label'];
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 0 };

    function lead(s) { return s.match(/^\s*/)[0]; }
    function trail(s) { return s.match(/\s*$/)[0]; }

    function doText(node) {
        var p = node.parentNode;
        if (!p || SKIP[p.nodeName]) return;
        var rec = TEXT_ORIG.get(node);
        var val = node.nodeValue;
        var src = (rec && rec.out === val) ? rec.src : val;       // unchanged since we wrote it → keep English source
        if (current === 'en') {
            if (rec && rec.out === val && src !== val) node.nodeValue = src;
            TEXT_ORIG.delete(node);
            return;
        }
        if (!/[A-Za-z]/.test(src)) { if (rec) TEXT_ORIG.delete(node); return; }
        var out = tr(src, current);
        if (out === src) { if (rec) TEXT_ORIG.delete(node); return; }
        var finalVal = lead(src) + out + trail(src);
        TEXT_ORIG.set(node, { src: src, out: finalVal });
        if (node.nodeValue !== finalVal) node.nodeValue = finalVal;
    }

    function doAttr(el, attr) {
        var val = el.getAttribute(attr);
        if (val == null) return;
        var map = ATTR_ORIG.get(el) || {};
        var rec = map[attr];
        var src = (rec && rec.out === val) ? rec.src : val;
        if (current === 'en') {
            if (rec && rec.out === val && src !== val) el.setAttribute(attr, src);
            if (rec) { delete map[attr]; }
            return;
        }
        var out = tr(src, current);
        if (out === src) { if (rec) delete map[attr]; return; }
        map[attr] = { src: src, out: out };
        ATTR_ORIG.set(el, map);
        if (val !== out) el.setAttribute(attr, out);
    }

    function walk(root) {
        if (!root) return;
        if (root.nodeType === 3) { doText(root); return; }
        if (root.nodeType !== 1 || SKIP[root.nodeName]) return;
        ATTRS.forEach(function (a) { if (root.hasAttribute && root.hasAttribute(a)) doAttr(root, a); });
        var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
        var n;
        while ((n = w.nextNode())) {
            if (n.nodeType === 3) doText(n);
            else if (!SKIP[n.nodeName]) ATTRS.forEach(function (a) { if (n.hasAttribute(a)) doAttr(n, a); });
        }
    }

    var observer = null;
    function startObserver() {
        if (observer || !document.body) return;
        observer = new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                var m = muts[i];
                if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]); }
                else if (m.type === 'characterData') doText(m.target);
                else if (m.type === 'attributes') doAttr(m.target, m.attributeName);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    }

    function applyDirection() {
        var de = document.documentElement;
        de.setAttribute('lang', current);
        de.setAttribute('dir', LANGS[current].dir);
    }

    var listeners = [];
    function setLang(code, silent) {
        if (!LANGS[code]) code = 'en';
        current = code;
        try { localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* storage blocked */ }
        applyDirection();
        walk(document.body);
        if (!silent) listeners.forEach(function (cb) { try { cb(code); } catch (e) { /* ignore */ } });
    }

    // Translate from JS code — {0}-style args are substituted after lookup.
    function t(key) {
        var args = Array.prototype.slice.call(arguments, 1);
        var out = tr(key, current);
        if (out === key && args.length) out = key;
        return out.replace(/\{(\d+)\}/g, function (_, n) { return args[+n] !== undefined ? args[+n] : ''; });
    }

    window.i18n = {
        LANGS: LANGS,
        lang: function () { return current; },
        setLang: setLang,
        onChange: function (cb) { listeners.push(cb); },
        t: t,
        tr: function (s) { return tr(s, current); },
        // Debug helper: after browsing the app in ru/ar, call i18n.missing() in the
        // console to list every visible English string that still has no translation.
        missing: function () {
            var out = {};
            var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n;
            while ((n = w.nextNode())) {
                var p = n.parentNode; if (!p || SKIP[p.nodeName]) continue;
                var rec = TEXT_ORIG.get(n);
                if (rec && rec.out === n.nodeValue) continue;
                var s = norm(n.nodeValue);
                if (/[A-Za-z]{3,}/.test(s) && current !== 'en' && tr(s, current) === s) out[s] = 1;
            }
            return Object.keys(out);
        },
    };

    current = detect();
    applyDirection();
    startObserver();
    walk(document.body);
})();
