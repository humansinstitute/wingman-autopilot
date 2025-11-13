const HERO_ATTRIBUTIONS = [
  "Sun Tzu, Art of War. Probably.",
  "Benjamin Franklin. Probably.",
  "Nelson Mandela. Probably.",
  "Jesus, Madeira. Probably.",
  "Thomas Jefferson. Probably.",
  "Nikola Tesla. Probably.",
];

const pickRandomAttribution = () => {
  if (HERO_ATTRIBUTIONS.length === 0) {
    return "Someone insightful. Probably.";
  }
  const index = Math.floor(Math.random() * HERO_ATTRIBUTIONS.length);
  return HERO_ATTRIBUTIONS[index];
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

  quote.append(quoteText);

  const attribution = document.createElement("cite");
  attribution.className = "wm-home-guest-hero-attribution";
  attribution.textContent = `- ${pickRandomAttribution()}`;

  const actions = createHeroActions({ onLogin });

  card.append(quote, attribution, actions);
  return card;
}
