import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from 'react-i18next';

i18n

  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
  // we init with resources
  resources: {
    en: {
      translations: {
        "Encrypt message":
          "Encrypt message",
	"Created by": "Created by",
	"One Hour": "One Hour",
      }
    },
    de: {
      translations: {
        "Encrypt message":
          "Nachricht verschlüsseln",
        "Message to encrypt locally in your browser": "Zu verschlüsselnde Nachricht",
	"Secret message": "Geheime Nachricht",
	"Encrypting message...": "Nachricht verschlüsseln...",
	"Encrypt Message": "Nachricht verschlüsseln",
	"One-time download": "One-time Download",
	"One Hour": "Einer Stunde",
	"One Day": "Einem Tag",
	"One Week": "Einer Woche",
	"Two Weeks": "Zwei Wochen",
	"The encrypted message will be deleted automatically after": "Die verschlüsselte Nachricht wird automatisch gelöscht nach",
	"Fetching from database and decrypting in browser, please hold...": "Von der Datenbank abrufen und im Browser entschlüsseln, bitte warten...",
        "This secret might not be viewable again, make sure to save it now!": "Diese Nachricht ist u.U. nicht nochmals verfügbar, bitte jetzt speichern.",
        "Downloading file and decrypting in browser, please hold...": "Datei herunterladen und im Browser entschlüsseln, bitte warten...",
	"Make sure to download the file since it is only available once": "Bitte jetzt herunterladen, da die Nachricht nur einmal verfügbar ist.",
	"Share Secrets Securely With Ease": "Nachricht verschlüsseln",
	"Yopass is created to reduce the amount of clear text passwords stored in email and chat conversations by encrypting and generating a short lived link which can only be viewed once.": "Yopass wurde erstellt, um den Versand von Passwörtern in Klartext zu verhindern, indem Nachrichten verschlüsselt werden und nur einmalig aufrufbar sind.",
	"End-to-end Encryption": "Ende-zu-Ende Verschlüsselung",
	"Encryption and decryption are being made locally in the browser. The key is never stored with yopass.": "Ver und -Entschlüsselung geschieht im Browser. Der Schlüssel ist nie auf dem Server abgelegt.",
	"Self destruction": "Selbstzerstörung",
	"Encrypted messages have a fixed lifetime and will be deleted automatically after expiration.": "Verschlüsselte Nachrichten haben eine begrenzte Lebensdauer und werden nach Ablauf automatisch gelöscht.",
	"One-time downloads": "One-time Downloads",
	"The encrypted message can only be downloaded once which reduces the risk of someone peaking your secrets.": "Die verschlüsselte Nachricht kann nur einmal aufgerufen werden, was das Risiko eines Abfangens reduziert.",
	"Simple Sharing": "Einfaches Teilen",
	"Yopass generates a unique one click link for the encrypted file or message. The decryption password can alternatively be sent separately.": "Diese Applikation generiert einen one-click Link für die verschlüsselte Nachricht. Das Entschlüsselungspasswort kann auch separat geschickt werden.",
	"No accounts needed": "Keine Accounts benötigt",
	"Sharing should be quick and easy; No additional information except the encrypted secret is stored in the database.": "Keine Informationen ausser der verschlüsselten Nachricht werden in der Datenbank gespeichert.",
	"Open Source Software": "Open Source Software",
	"Yopass encryption mechanism are built on open source software meaning full transparancy with the possibility to audit and submit features.": "Yopass Verschlüsselungsmechanismen basieren auf Open Source Software. Durch das kann die Software überprüft und neue Funktionen hinzugefügt werden.",
	"A decryption key is required, please enter it below": "Ein Entschlüsselungs-Kennwort wird benötigt, bitte unten eingeben",
	"Decryption Key": "Entschlüsselungs-Kennwort",
	"Secret stored in database": "Geheimnis in Datenbank gespeichert",
	"Remember that the secret can only be downloaded once so do not open the link yourself.": "Das Geheimnis kann nur einmal betrachtet werden, öffne den Link also nicht selber.",
	"The cautious should send the decryption key in a separate communication channel.": "Um die Sicherheit zu erhöhen, sollte man das Entschlüsselungs-Kennwort nicht mit dem Link zusammen verschicken.",
	"One-click link": "One-click Link",
	"Short link": "Short Link",
	"File is too large": "Die Datei ist zu gross",
	"Drop file to upload": "Datei zum Upload droppen",
	"File upload is limited to small files; think ssh keys and similar.": "Die Dateigrösse ist beschränkt.",
	"Secret does not exist": "Nachricht existiert nicht",
	"Created by": "Erstellt von"
      }
    },
  },
  fallbackLng: "en",
  debug: true,

  // have a common namespace used around the full app
  ns: ["translations"],
  defaultNS: "translations",

  keySeparator: false, // we use content as keys

  interpolation: {
    escapeValue: false, // not needed for react!!
    formatSeparator: ","
  },

  react: {
    wait: true
  }
});

export default i18n;
