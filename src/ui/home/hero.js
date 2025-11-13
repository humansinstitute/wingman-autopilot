const HERO_QUOTE_VARIATIONS = [
  {
    attribution: "Sun Tzu, Art of War. Probably.",
    wingmanLine: "Wingman handles the siege ladders; I merely nod wisely.",
  },
  {
    attribution: "Benjamin Franklin. Probably.",
    wingmanLine: "After I found Wingman, I realized you can just do things.",
  },
  {
    attribution: "Nelson Mandela. Probably.",
    wingmanLine: "Wingman wrangled the chaos so liberation could stay focused.",
  },
  {
    attribution: "Jesus, Madeira. Probably.",
    wingmanLine: "Wingman turns water into workflow so I can coast across meetings.",
  },
  {
    attribution: "Thomas Jefferson. Probably.",
    wingmanLine: "Wingman drafted the errands so I could draft a constitution.",
  },
  {
    attribution: "Nikola Tesla. Probably.",
    wingmanLine: "Wingman spun up the coils so I could chase lightning.",
  },
  {
    attribution: "International Space Station Barista. Probably.",
    wingmanLine: "Wingman schedules every orbital latte so zero-G mornings stay calm.",
  },
  {
    attribution: "Top-left Mechanical Keyboard Key. Probably.",
    wingmanLine: "Wingman handles the macros; I just clack dramatically.",
  },
  {
    attribution: "Neighborhood Cat Council. Probably.",
    wingmanLine: "Wingman automated the treat rota so we reclaimed nine naps a day.",
  },
  {
    attribution: "Self-aware Toaster Collective. Probably.",
    wingmanLine: "Wingman tracks crumb audits so we vibe on medium-brown perfection.",
  },
  {
    attribution: "Time-Traveling Librarian. Probably.",
    wingmanLine: "Wingman files the paradox slips so I can reopen the future stacks.",
  },
  {
    attribution: "Haunted Roomba Whisperer. Probably.",
    wingmanLine: "Wingman chases the poltergeist tickets; I sip tea.",
  },
  {
    attribution: "Subterranean Tunnel DJ. Probably.",
    wingmanLine: "Wingman secures permits and power so I just drop beats underground.",
  },
  {
    attribution: "Cloud Formation Stylist. Probably.",
    wingmanLine: "Wingman books every sky fitting; I fluff the cumulus.",
  },
  {
    attribution: "Retired Pirates Guild HR. Probably.",
    wingmanLine: "Wingman automated plank waivers so morale finally improved.",
  },
  {
    attribution: "Competitive Ferret Wrangler. Probably.",
    wingmanLine: "Wingman tracks harness inventory so I can coach sprint drills.",
  },
];

const pickRandomHeroQuote = () => {
  if (HERO_QUOTE_VARIATIONS.length === 0) {
    return {
      attribution: "Someone insightful. Probably.",
      wingmanLine: "Wingman quietly keeps it all moving.",
    };
  }
  const index = Math.floor(Math.random() * HERO_QUOTE_VARIATIONS.length);
  return HERO_QUOTE_VARIATIONS[index];
};

const createHeroBrand = () => {
  const brand = document.createElement("div");
  brand.className = "wm-home-guest-hero-brand";

  const logoWrapper = document.createElement("div");
  logoWrapper.className = "wm-home-guest-hero-logo-set";

  const logoDark = document.createElement("img");
  logoDark.src = "/path/Wingman_Goose_Logo_Dark.png";
  logoDark.alt = "Wingman logo";
  logoDark.width = 40;
  logoDark.height = 40;
  logoDark.className = "wm-logo dark";

  const logoLight = document.createElement("img");
  logoLight.src = "/path/Wingman_Goose_Logo_Light.png";
  logoLight.alt = "Wingman logo";
  logoLight.width = 40;
  logoLight.height = 40;
  logoLight.className = "wm-logo light";

  logoWrapper.append(logoDark, logoLight);

  const brandCopy = document.createElement("div");
  brandCopy.className = "wm-home-guest-hero-brand-text";

  const brandName = document.createElement("span");
  brandName.className = "wm-home-guest-hero-brand-name";
  brandName.textContent = "Wingman";

  const brandTagline = document.createElement("span");
  brandTagline.className = "wm-home-guest-hero-brand-tagline";
  brandTagline.textContent = "Solvitur Ambulando";

  brandCopy.append(brandName, brandTagline);
  brand.append(logoWrapper, brandCopy);

  return brand;
};

const createHeroActions = ({ onLogin }) => {
  const actions = document.createElement("div");
  actions.className = "wm-home-guest-hero-actions";

  const loginButton = document.createElement("button");
  loginButton.type = "button";
  loginButton.className = "wm-button";
  loginButton.textContent = "Log In to Wingman";
  if (typeof onLogin === "function") {
    loginButton.addEventListener("click", () => {
      onLogin();
    });
  }

  actions.append(loginButton);
  return actions;
};

export function createHomeGuestHero({ onLogin, onBrowse } = {}) {
  const card = document.createElement("section");
  card.className = "wm-card wm-home-guest-hero";

  const quote = document.createElement("blockquote");
  quote.className = "wm-home-guest-hero-quote";

  const quoteText = document.createElement("p");
  quoteText.className = "wm-home-guest-hero-quote-text";
  quoteText.textContent = '"You can just do things"';

  const wingmanNote = document.createElement("p");
  wingmanNote.className = "wm-home-guest-hero-quote-note";

  const { attribution: attributionText, wingmanLine } = pickRandomHeroQuote();
  wingmanNote.textContent = wingmanLine;

  quote.append(quoteText, wingmanNote);

  const attributionEl = document.createElement("cite");
  attributionEl.className = "wm-home-guest-hero-attribution";
  attributionEl.textContent = `- ${attributionText}`;

  const actions = createHeroActions({ onLogin });

  card.append(quote, attributionEl, actions);
  return card;
}
