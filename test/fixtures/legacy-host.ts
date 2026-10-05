// Minimal host UI mocks for the previous production controller only.
export class MarkdownView {}
export class Menu { addItem() { return this; } showAtMouseEvent() {} }
export class Notice { constructor(readonly message: string) {} }
