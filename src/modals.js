// Barrel for the modal modules so consumers keep one import path.
const { TextPromptModal, ConfirmModal, alertAction, confirmAction } = require("./modals/prompt-modals");
const { LabelPickerModal } = require("./modals/label-picker-modal");
const { ListColorModal } = require("./modals/list-color-modal");
const { BoardAppearanceModal } = require("./modals/board-appearance-modal");
const { CardDatesModal } = require("./modals/card-dates-modal");
const { AboutModal } = require("./modals/about-modal");
const { CardModal } = require("./modals/card-modal");
const { CardPickerModal } = require("./modals/card-picker-modal");
const { detailsMdToHtml, autoformatCommandForPrefix, inlineAutoformatMatch, splitDetailSegments } = require("./modals/details-markdown");

module.exports = {
  ConfirmModal,
  TextPromptModal,
  LabelPickerModal,
  ListColorModal,
  BoardAppearanceModal,
  CardDatesModal,
  AboutModal,
  CardModal,
  CardPickerModal,
  alertAction,
  confirmAction,
  detailsMdToHtml,
  autoformatCommandForPrefix,
  inlineAutoformatMatch,
  splitDetailSegments,
};
