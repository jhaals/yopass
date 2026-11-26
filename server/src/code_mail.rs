//! The text of the one-time code mail, in the languages the web interface
//! speaks. The recipient's browser picks the language when the code is asked for.

/// Subject, intro (before the code), validity (with `{time}`) and closing line.
/// The intro carries `{app}`, the instance's name.
type Text = [&'static str; 4];

const TEXTS: &[(&str, Text)] = &[
    (
        "en",
        [
            "your one-time code",
            "Your code to open a secret on {app}:",
            "It is valid until {time} and works once.",
            "If you did not ask for it, ignore this email.",
        ],
    ),
    (
        "be",
        [
            "ваш аднаразовы код",
            "Ваш код для адкрыцця сакрэту на {app}:",
            "Ён дзейнічае да {time} і спрацуе адзін раз.",
            "Калі вы яго не запытвалі, праігнаруйце гэты ліст.",
        ],
    ),
    (
        "cs",
        [
            "váš jednorázový kód",
            "Váš kód k otevření tajemství na {app}:",
            "Platí do {time} a lze jej použít jednou.",
            "Pokud jste o něj nežádali, tento e-mail ignorujte.",
        ],
    ),
    (
        "da",
        [
            "din engangskode",
            "Din kode til at åbne en hemmelighed på {app}:",
            "Den er gyldig til {time} og kan bruges én gang.",
            "Hvis du ikke har bedt om den, kan du se bort fra denne e-mail.",
        ],
    ),
    (
        "de",
        [
            "dein Einmalcode",
            "Dein Code zum Öffnen eines Geheimnisses auf {app}:",
            "Er gilt bis {time} und kann einmal verwendet werden.",
            "Wenn du ihn nicht angefordert hast, ignoriere diese E-Mail.",
        ],
    ),
    (
        "es",
        [
            "tu código de un solo uso",
            "Tu código para abrir un secreto en {app}:",
            "Es válido hasta {time} y solo se puede usar una vez.",
            "Si no lo has solicitado, ignora este correo.",
        ],
    ),
    (
        "fi",
        [
            "kertakäyttökoodisi",
            "Koodisi salaisuuden avaamiseen palvelussa {app}:",
            "Se on voimassa {time} asti ja toimii kerran.",
            "Jos et pyytänyt sitä, voit jättää tämän viestin huomiotta.",
        ],
    ),
    (
        "fr",
        [
            "votre code à usage unique",
            "Votre code pour ouvrir un secret sur {app} :",
            "Il est valable jusqu'au {time} et ne fonctionne qu'une fois.",
            "Si vous ne l'avez pas demandé, ignorez cet e-mail.",
        ],
    ),
    (
        "he",
        [
            "הקוד החד-פעמי שלך",
            "הקוד לפתיחת סוד ב-{app}:",
            "הוא בתוקף עד {time} וניתן להשתמש בו פעם אחת.",
            "אם הקוד לא התבקש, אפשר להתעלם מהודעה זו.",
        ],
    ),
    (
        "it",
        [
            "il tuo codice monouso",
            "Il tuo codice per aprire un segreto su {app}:",
            "È valido fino a {time} e funziona una sola volta.",
            "Se non l'hai richiesto, ignora questa email.",
        ],
    ),
    (
        "ja",
        [
            "ワンタイムコード",
            "{app} でシークレットを開くためのコード:",
            "有効期限は {time} までで、1 回だけ使用できます。",
            "心当たりがない場合は、このメールを無視してください。",
        ],
    ),
    (
        "nl",
        [
            "je eenmalige code",
            "Je code om een geheim te openen op {app}:",
            "Hij is geldig tot {time} en werkt één keer.",
            "Heb je hem niet aangevraagd? Negeer dan deze e-mail.",
        ],
    ),
    (
        "no",
        [
            "engangskoden din",
            "Koden din for å åpne en hemmelighet på {app}:",
            "Den er gyldig til {time} og kan brukes én gang.",
            "Hvis du ikke har bedt om den, kan du se bort fra denne e-posten.",
        ],
    ),
    (
        "pl",
        [
            "Twój kod jednorazowy",
            "Twój kod do otwarcia sekretu w {app}:",
            "Jest ważny do {time} i działa jeden raz.",
            "Jeśli nie prosiłeś o ten kod, zignoruj tę wiadomość.",
        ],
    ),
    (
        "pt",
        [
            "o seu código de utilização única",
            "O seu código para abrir um segredo em {app}:",
            "É válido até {time} e só pode ser usado uma vez.",
            "Se não o pediu, ignore este e-mail.",
        ],
    ),
    (
        "ro",
        [
            "codul tău de unică folosință",
            "Codul tău pentru a deschide un secret pe {app}:",
            "Este valabil până la {time} și funcționează o singură dată.",
            "Dacă nu l-ai cerut, ignoră acest e-mail.",
        ],
    ),
    (
        "ru",
        [
            "ваш одноразовый код",
            "Ваш код для открытия секрета на {app}:",
            "Он действует до {time} и сработает один раз.",
            "Если вы его не запрашивали, проигнорируйте это письмо.",
        ],
    ),
    (
        "sv",
        [
            "din engångskod",
            "Din kod för att öppna en hemlighet på {app}:",
            "Den gäller till {time} och fungerar en gång.",
            "Om du inte har bett om den kan du bortse från det här mejlet.",
        ],
    ),
    (
        "tr",
        [
            "tek kullanımlık kodunuz",
            "{app} üzerinde bir sırrı açmak için kodunuz:",
            "{time} tarihine kadar geçerlidir ve yalnızca bir kez kullanılabilir.",
            "Bu kodu siz istemediyseniz bu e-postayı yok sayın.",
        ],
    ),
];

/// The first language in an `Accept-Language` value that a text exists for,
/// else English. Browsers list languages by preference already.
pub fn language(accept_language: &str) -> &'static str {
    accept_language
        .split(',')
        .filter_map(|entry| entry.split(';').next())
        .map(|tag| {
            tag.trim()
                .split('-')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        })
        .map(|primary| match primary.as_str() {
            // Bokmål and Nynorsk share the Norwegian text.
            "nb" | "nn" => "no".to_owned(),
            _ => primary,
        })
        .find_map(|primary| TEXTS.iter().find(|(lang, _)| *lang == primary))
        .map_or("en", |(lang, _)| lang)
}

/// Subject and body of the code mail in `lang`, as [`language`] returns it.
pub fn render(lang: &str, app: &str, code: &str, valid_until: &str) -> (String, String) {
    let [subject, intro, valid, closing] = TEXTS
        .iter()
        .find(|(l, _)| *l == lang)
        .unwrap_or(&TEXTS[0])
        .1;
    let body = format!(
        "{}\n\n    {code}\n\n{}\n\n{closing}\n",
        intro.replace("{app}", app),
        valid.replace("{time}", valid_until),
    );
    (subject.to_owned(), body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_preferred_known_language_wins() {
        assert_eq!(language("sv-SE,sv;q=0.9,en;q=0.8"), "sv");
        assert_eq!(language("xx,de;q=0.5"), "de");
        assert_eq!(language("nb-NO"), "no");
        assert_eq!(language("PT-pt"), "pt");
        assert_eq!(language(""), "en");
        assert_eq!(language("*"), "en");
    }

    #[test]
    fn every_language_has_its_placeholders() {
        for (lang, [subject, intro, valid, closing]) in TEXTS {
            assert!(!subject.is_empty() && !closing.is_empty(), "{lang}");
            assert!(intro.contains("{app}"), "{lang}");
            assert!(valid.contains("{time}"), "{lang}");
        }
        let (_, body) = render("en", "Acme", "123456", "noon");
        assert!(body.contains("\n    123456\n") && body.contains("Acme") && body.contains("noon"));
    }
}
