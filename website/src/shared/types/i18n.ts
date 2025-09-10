// Type definitions for i18n resources
export interface TranslationResources {
  create: {
    title: string;
    inputSecretLabel: string;
    inputSecretPlaceholder: string;
    buttonEncrypt: string;
    inputCustomPasswordLabel: string;
    inputCustomPasswordPlaceholder: string;
    inputOneTimeLabel: string;
    inputGenerateKeyLabel: string;
  };
  upload: {
    title: string;
    buttonUpload: string;
    uploadFileButton: string;
    dragDropText: string;
    fileDescription: string;
    errorSelectFile: string;
    errorFailedToRead: string;
    expirationLegendFile: string;
  };
  display: {
    titleDecrypting: string;
    titleDecryptionKey: string;
    captionDecryptionKey: string;
    inputDecryptionKeyPlaceholder: string;
    inputDecryptionKeyLabel: string;
    errorInvalidPassword: string;
    buttonDecrypt: string;
    decryptingMessage: string;
    errorInvalidPasswordDetailed: string;
    buttonDecryptSecret: string;
    loading: string;
    secureMessageTitle: string;
    secureMessageSubtitle: string;
    importantTitle: string;
    oneTimeWarning: string;
    oneTimeWarningReady: string;
    buttonRevealMessage: string;
  };
  error: {
    title: string;
    subtitle: string;
    titleOpened: string;
    subtitleOpenedBefore: string;
    subtitleOpenedCompromised: string;
    titleBrokenLink: string;
    subtitleBrokenLink: string;
    titleExpired: string;
    subtitleExpired: string;
  };
  result: {
    title: string;
    subtitle: string;
    subtitleDownloadOnce: string;
    reminderTitle: string;
    rowLabelOneClick: string;
    rowOneClickDescription: string;
    rowLabelShortLink: string;
    rowShortLinkDescription: string;
    rowLabelDecryptionKey: string;
    rowDecryptionKeyDescription: string;
    buttonCreateAnother: string;
  };
  secret: {
    titleFile: string;
    subtitleFile: string;
    fileDownloaded: string;
    buttonDownloadFile: string;
    titleMessage: string;
    subtitleMessage: string;
    buttonCopy: string;
    buttonCopyToClipboard: string;
    buttonCopied: string;
    showQrCode: string;
    hideQrCode: string;
  };
  delete: {
    buttonDelete: string;
    messageDeleted: string;
    dialogTitle: string;
    dialogMessage: string;
    dialogProgress: string;
    dialogConfirm: string;
    dialogCancel: string;
  };
  expiration: {
    legend: string;
    optionOneHourLabel: string;
    optionOneDayLabel: string;
    optionOneWeekLabel: string;
  };
  features: {
    title: string;
    subtitle: string;
    featureEndToEndTitle: string;
    featureEndToEndText: string;
    featureSelfDestructionTitle: string;
    featureSelfDestructionText: string;
    featureOneTimeTitle: string;
    featureOneTimeText: string;
    featureSimpleSharingTitle: string;
    featureSimpleSharingText: string;
    featureNoAccountsTitle: string;
    featureNoAccountsText: string;
    featureOpenSourceTitle: string;
    featureOpenSourceText: string;
  };
  header: {
    buttonHome: string;
    buttonUpload: string;
    buttonText: string;
    appName: string;
  };
  common: {
    copy: string;
    copied: string;
  };
  footer: {
    privacyNotice: string;
    imprint: string;
    createdBy: string;
  };
}
