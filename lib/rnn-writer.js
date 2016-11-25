let RNNWriter;
import { Range, Point, CompositeDisposable, NotificationManager } from "atom";

import request from "request-json";
import sfx from "sfx";
// nlp = require "nlp_compromise" # skipping this for now

export default RNNWriter = {

  // let's muddle through CoffeeScript together, shall we

  config: require("./rnn-writer-config"),

  keySubscriptions: null, // do I need to list these here?? I don't know
  cursorSubscription: null,

  activate(state) {
    this.keySubscriptions = new CompositeDisposable;
    this.keySubscriptions.add(atom.commands.add("atom-workspace", {"rnn-writer:toggle": () => this.toggle()}));

    // note: all these key command wrapper functions are down at the very bottom
    this.keySubscriptions.add(atom.commands.add("atom-workspace", {"rnn-writer:suggest": () => this.keySuggest()}));
    this.keySubscriptions.add(atom.commands.add("atom-workspace", {"rnn-writer:scroll-up-suggestion": () => this.keyScrollUpSuggestion()}));
    this.keySubscriptions.add(atom.commands.add("atom-workspace", {"rnn-writer:scroll-down-suggestion": () => this.keyScrollDownSuggestion()}));
    this.keySubscriptions.add(atom.commands.add("atom-workspace", {"rnn-writer:accept-suggestion-right": () => this.keyAcceptSuggestion("right")}));
    this.keySubscriptions.add(atom.commands.add("atom-workspace", {"rnn-writer:accept-suggestion-enter": () => this.keyAcceptSuggestion("enter")}));
    this.keySubscriptions.add(atom.commands.add("atom-workspace", {"rnn-writer:cancel-suggestion-left": () => this.keyCancelSuggestion("left")}));
    this.keySubscriptions.add(atom.commands.add("atom-workspace", {"rnn-writer:cancel-suggestion-esc": () => this.keyCancelSuggestion("escape")}));

    return this.running = false;
  },

  toggle() {
    if (!this.running) {
      if (atom.config.get("rnn-writer.overrideBracketMatcher")) {
        atom.config.set("bracket-matcher.autocompleteBrackets", false); // :)
      }

      this.LOOKBACK_LENGTH = atom.config.get("rnn-writer.lookbackLength");
      this.NUM_SUGGESTIONS_PER_REQUEST = atom.config.get("rnn-writer.numberOfSuggestionsPerRequest");
      if (atom.config.get("rnn-writer.textBargains.usingTextBargains")) {
        this.GENERATOR_BASE = "https://text.bargains";
        this.API_KEY = atom.config.get("rnn-writer.textBargains.apiKey");
      } else if (atom.config.get("rnn-writer.localSuggestionGenerator")) {
        this.GENERATOR_BASE = atom.config.get("rnn-writer.localSuggestionGenerator");
      } else {
        this.showError("There's no server specified in the `rnn-writer` package settings.");
        return;
      }

      this.GET_MORE_SUGGESTIONS_THRESHOLD = 3;

      this.client = request.createClient(this.GENERATOR_BASE);
      if (this.API_KEY) { this.client.headers["x-api-key"] = this.API_KEY; }

      this.client.get("/", (error, response, body) => {
        if (error) {
          console.log("...error.");
          console.log(JSON.stringify(error, null, 2));
          this.showError("Tried to start RNN Writer, but couldn't reach the server. Check your developer console for more details.");
          return this.running = false;
        } else {
          let successMessage = "RNN Writer is up and running. Press `tab` for completions.";
          if (this.API_KEY && body["message"]) { successMessage += ` ${body["message"]}`; }
          this.showMessage(successMessage);
          return this.running = true;
        }
      }
      );

      return this.reset("Setting all vars for the first time.");

    } else {
      this.showMessage("RNN Writer has shut down.");
      this.running = false;
      return this.reset("Shutting down for now.");
    }
  },

  deactivate() {
    this.reset("Deactivated!");
    if (this.keySubscriptions != null) {
      this.keySubscriptions.dispose();
    }
    if (this.cursorSubscription != null) {
      return this.cursorSubscription.dispose();
    }
  },

  reset(message) {
    this.suggestions = [];
    this.suggestionIndex = 0;
    [this.currentStartText, this.currentSuggestionText] = ["", ""];
    [this.offeringSuggestions, this.changeSuggestionInProgress] = [false, false];
    if (this.suggestionMarker != null) {
      this.suggestionMarker.destroy();
    }
    if (this.spinner != null) {
      this.spinner.destroy();
    }

    return console.log(message);
  },

  // IGNORE THIS PART
  // not currently used

  updateEntities() {
    this.editor = atom.workspace.getActiveTextEditor();
    if (this.editor.getBuffer().getText().split(" ").length > 4) {
      let nlpText = nlp.text(this.editor.getBuffer().getText());
      return this.people = nlpText.people().length > 0 ?
        nlpText.people().map(entity => entity.text)
      :
        ["she", "Jenny", "Jenny Nebula"];
    } else {
      return this.people = ["she", "Jenny", "Jenny Nebula"];
    }
  },

  randomFrom(array) {
    return array[Math.floor(Math.random()*array.length)];
  },

  interpolateEntityIntoSuggestion(suggestion) {
    // person placeholder char is @
    if (suggestion.includes("@")) {
      suggestion = suggestion.replace(/@/g, this.randomFrom(this.people));
    }

    return suggestion;
  },

  // OK STOP IGNORING

  // interface

  showMessage(messageText) {
    return atom.notifications.addInfo(`🤖 ${messageText}`, {dismissable: true, icon: "radio-tower"});
  },

  showError(errorText) {
    sfx.basso();
    return atom.notifications.addError(`🤖 ${errorText}`, {dismissable: true, icon: "stop"});
  },

  showSpinner() { // while waiting for server response
    if (this.spinner != null) {
      this.spinner.destroy();
    }

    let spinnerSpan = document.createElement("span");
    spinnerSpan.className = "loading loading-spinner-tiny inline-block rnn-spinner-hack";

    let buffer = this.editor.getBuffer();
    let startCharIndex = buffer.characterIndexForPosition(this.editor.getCursorBufferPosition());
    let currentSuggestionEndPos = buffer.positionForCharacterIndex(startCharIndex + this.currentSuggestionText.length);

    this.spinner = buffer.markPosition(currentSuggestionEndPos);
    return this.editor.decorateMarker(this.spinner, {type: "overlay", position: "head", item: spinnerSpan});
  },

  // vaguely chronological application lifecycle begins here

  lookBackToGetStartText(howManyChars) {
    // this is very step-by-step to make it easier for me to follow
    let buffer = this.editor.getBuffer();
    let endPos = this.editor.getCursorBufferPosition();
    let endCharIndex = buffer.characterIndexForPosition(endPos);
    let startCharIndex = endCharIndex - howManyChars;
    let startPos = buffer.positionForCharacterIndex(startCharIndex);
    let startTextRange = new Range(startPos, endPos);
    return this.editor.getBuffer().getTextInRange(startTextRange);
  },

  suggest() {
    this.offeringSuggestions = true;

    // make double extra sure we have the current editor
    this.editor = atom.workspace.getActiveTextEditor();
    this.editor.setSoftWrapped(true); // it is perhaps a bit aggro to put this here, but it kept bothering me

    // watch the cursor in this editor
    if (this.cursorSubscription != null) {
      this.cursorSubscription.dispose();
    }
    this.cursorSubscription = new CompositeDisposable;
    this.cursorSubscription.add(this.editor.onDidChangeCursorPosition(() => this.loseFocus()));

    // showtime!
    this.currentStartText = this.lookBackToGetStartText(this.LOOKBACK_LENGTH);
    return this.getSuggestions();
  },

  queryForCurrentStartText() {
    return `/generate?start_text=${encodeURIComponent(this.currentStartText)}&n=${this.NUM_SUGGESTIONS_PER_REQUEST}`;
  },

  getSuggestions() {
    if (this.suggestions.length === 0) {
      this.suggestionPos = new Point(this.editor.getCursorBufferPosition().row, this.editor.getCursorBufferPosition().column); // ugh??
    }

    this.showSpinner();

    console.log("Fetching suggestions from server...");
    return this.client.get(this.queryForCurrentStartText(), (error, response, body) => {
      if (this.spinner != null) {
        this.spinner.destroy();
      }
      if (error) {
        console.log("...error.");
        this.showError(`<pre>${JSON.stringify(error, null, 2)}</pre>`);
        return this.reset("Network error (see notification)");
      } else {
        if (body["message"]) {
          console.log("...error.");
          switch (body["message"]) {
            case "Network error communicating with endpoint": this.showError("Looks like the server is offline."); break;
            case "Forbidden": this.showError("That API key doesn't appear to be valid."); break;
            default: this.showError(`The server replied with this error:<pre>${body["message"]}</pre>`);
          }
          return this.reset("Network error (see notification)");
        } else {
          let startTextForThisRequest = decodeURIComponent(body["start_text"]).replace(/\+/g, " "); // that extra replace is annoying
          if (this.offeringSuggestions && startTextForThisRequest === this.currentStartText) { // be careful! things might have changed!
            console.log("...success.");
            if (this.suggestions.length > 0) {
              return this.suggestions = this.suggestions.concat(body["completions"]);
            } else {
              this.suggestions = body["completions"];
              this.suggestionIndex = 0;
              return this.changeSuggestion();
            }
          } else {
            // can get into some weird states here, but it's fine for now
            return console.log("Note: received outdated server reply. Ignoring.");
          }
        }
      }
    }
    );
  },

  changeSuggestion() {
    this.changeSuggestionInProgress = true; // dear event handler: please don't respond to cursor moves while in this block

    let newSuggestionText = this.suggestions[this.suggestionIndex] + " "; // always with the extra space; this might be annoying?

    // get start point
    let buffer = this.editor.getBuffer();
    let startCharIndex = buffer.characterIndexForPosition(this.suggestionPos);

    // clear old text
    let oldEndPos = buffer.positionForCharacterIndex(startCharIndex + this.currentSuggestionText.length);
    this.editor.setTextInBufferRange(new Range(this.suggestionPos, oldEndPos), "");

    this.editor.setCursorBufferPosition(this.suggestionPos); // go back to the place where this all started
    this.editor.insertText(newSuggestionText); // insert new text
    this.editor.setCursorBufferPosition(this.suggestionPos); // keep the cursor where it was

    // mark the new text's region
    let newEndPos = buffer.positionForCharacterIndex(startCharIndex + newSuggestionText.length);
    if (this.suggestionMarker != null) {
      this.suggestionMarker.destroy();
    }
    this.suggestionMarker = this.editor.markBufferRange(new Range(this.suggestionPos, newEndPos), {invalidate: "inside"});
    this.editor.decorateMarker(this.suggestionMarker, {type: "highlight", class: "rnn-suggestion"});

    // the new text becomes the old text
    this.currentSuggestionText = newSuggestionText + "";

    sfx.pop(); // :)
    return this.changeSuggestionInProgress = false; // back to normal
  },

  cancelSuggestion() {
    let buffer = this.editor.getBuffer();
    let startCharIndex = buffer.characterIndexForPosition(this.suggestionPos);
    let endPos = buffer.positionForCharacterIndex(startCharIndex + this.currentSuggestionText.length);
    this.editor.setTextInBufferRange(new Range(this.suggestionPos, endPos), "");
    this.editor.setCursorBufferPosition(this.suggestionPos);

    return this.reset("Suggestion canceled.");
  },

  acceptSuggestion(moveCursorForward) {
    if (moveCursorForward) {
      let buffer = this.editor.getBuffer();
      let startCharIndex = buffer.characterIndexForPosition(this.suggestionPos);
      let endCharIndex = startCharIndex + this.currentSuggestionText.length;
      let endPos = buffer.positionForCharacterIndex(endCharIndex);
      this.editor.setCursorBufferPosition(endPos);
    }

    return this.reset("Suggestion accepted");
  },

  loseFocus() {
    if (this.offeringSuggestions) {
      if (!this.changeSuggestionInProgress) {
        return this.reset("Suggestion accepted implicitly");
      }
    }
  },

  // key command wrapper functions

  keySuggest() {
    this.editor = atom.workspace.getActiveTextEditor();

    if (this.running) {
      sfx.tink();
      if (this.offeringSuggestions) {
        return this.acceptSuggestion(true);
      } else {
        return this.suggest();
      }
    } else {
      return atom.commands.dispatch(atom.views.getView(this.editor), "editor:indent");
    }
  },

  keyScrollUpSuggestion() {
    this.editor = atom.workspace.getActiveTextEditor();

    if (this.running && this.offeringSuggestions) {
      if (this.suggestionIndex > 0) {
        this.suggestionIndex -= 1;
        return this.changeSuggestion();
      } else {
        return sfx.basso();
      }
    } else {
      return atom.commands.dispatch(atom.views.getView(this.editor), "core:move-up");
    }
  },

  keyScrollDownSuggestion() {
    this.editor = atom.workspace.getActiveTextEditor();

    if (this.running && this.offeringSuggestions) {
      if (this.suggestionIndex+1 < this.suggestions.length) {
        this.suggestionIndex += 1;
        this.changeSuggestion();
      } else {
        sfx.basso();
      }

      if ((this.suggestions.length - this.suggestionIndex) < this.GET_MORE_SUGGESTIONS_THRESHOLD) {
        return this.getSuggestions();
      }
    } else {
      return atom.commands.dispatch(atom.views.getView(this.editor), "core:move-down");
    }
  },

  keyAcceptSuggestion(key) {
    this.editor = atom.workspace.getActiveTextEditor();

    if (this.running && this.offeringSuggestions) {
      if (key === "right") {
        this.acceptSuggestion(false);
      }
      if (key === "enter") {
        return this.acceptSuggestion(true);
      }
    } else {
      if (key === "right") {
        atom.commands.dispatch(atom.views.getView(this.editor), "core:move-right");
      }
      if (key === "enter") {
        return atom.commands.dispatch(atom.views.getView(this.editor), "editor:newline");
      }
    }
  },

  keyCancelSuggestion(key) {
    console.log(key);
    this.editor = atom.workspace.getActiveTextEditor();

    if (this.running && this.offeringSuggestions) {
      return this.cancelSuggestion();
    } else {
      if (key === "left") {
        atom.commands.dispatch(atom.views.getView(this.editor), "core:move-left");
      }
      if (key === "escape") {
        return atom.commands.dispatch(atom.views.getView(this.editor), "editor:consolidate-selections");
      }
    }
  }
};
