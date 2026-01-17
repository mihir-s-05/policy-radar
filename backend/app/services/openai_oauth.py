"""
OpenAI OAuth service for ChatGPT Plus/Pro authentication.

This module implements the OAuth PKCE flow for authenticating with OpenAI's
ChatGPT backend, allowing users to use their ChatGPT subscription instead
of OpenAI Platform API credits.

Based on the opencode-openai-codex-auth implementation.
"""

import base64
import hashlib
import secrets
import json
import logging
import os
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlencode, urlparse, parse_qs

import httpx

logger = logging.getLogger(__name__)

# OAuth Configuration Constants
OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
OAUTH_AUTHORIZATION_ENDPOINT = "https://auth.openai.com/authorize"
OAUTH_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token"
_OAUTH_DEFAULT_REDIRECT_PATH = "/api/oauth/openai/callback"
OAUTH_REDIRECT_URI = os.getenv("OAUTH_REDIRECT_URI")
if not OAUTH_REDIRECT_URI:
    port = os.getenv("PORT", "8000")
    OAUTH_REDIRECT_URI = f"http://localhost:{port}{_OAUTH_DEFAULT_REDIRECT_PATH}"
OAUTH_SCOPE = "openid email profile offline_access"
OAUTH_AUDIENCE = "https://api.openai.com/v1"

# ChatGPT API Configuration
CHATGPT_API_BASE_URL = "https://api.openai.com/v1"

# HTTP Configuration
HTTP_STATUS_OK = 200
HTTP_STATUS_UNAUTHORIZED = 401


@dataclass
class PKCEPair:
    """PKCE code verifier and challenge pair."""
    verifier: str
    challenge: str


@dataclass
class AuthorizationFlow:
    """OAuth authorization flow data."""
    pkce: PKCEPair
    state: str
    authorization_url: str


@dataclass
class TokenResult:
    """Result of token exchange or refresh."""
    success: bool
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    expires_in: Optional[int] = None
    error: Optional[str] = None
    account_info: Optional[dict] = None


@dataclass
class OAuthTokens:
    """Stored OAuth tokens."""
    access_token: str
    refresh_token: str
    expires_at: float
    account_info: Optional[dict] = None


def create_state() -> str:
    """Generate a random state string for OAuth security validation."""
    return secrets.token_hex(16)


def create_pkce_pair() -> PKCEPair:
    """
    Generate a PKCE (Proof Key for Code Exchange) pair.

    Uses SHA-256 for the code challenge with S256 method.
    """
    # Generate a random 32-byte code verifier
    verifier_bytes = secrets.token_bytes(32)
    verifier = base64.urlsafe_b64encode(verifier_bytes).decode('utf-8').rstrip('=')

    # Create SHA-256 hash of the verifier
    challenge_bytes = hashlib.sha256(verifier.encode('utf-8')).digest()
    challenge = base64.urlsafe_b64encode(challenge_bytes).decode('utf-8').rstrip('=')

    return PKCEPair(verifier=verifier, challenge=challenge)


def create_authorization_flow() -> AuthorizationFlow:
    """
    Create a complete OAuth authorization flow.

    Generates PKCE pair, state, and constructs the authorization URL.
    """
    pkce = create_pkce_pair()
    state = create_state()

    params = {
        "client_id": OAUTH_CLIENT_ID,
        "redirect_uri": OAUTH_REDIRECT_URI,
        "response_type": "code",
        "scope": OAUTH_SCOPE,
        "audience": OAUTH_AUDIENCE,
        "state": state,
        "code_challenge": pkce.challenge,
        "code_challenge_method": "S256",
    }

    authorization_url = f"{OAUTH_AUTHORIZATION_ENDPOINT}?{urlencode(params)}"

    return AuthorizationFlow(
        pkce=pkce,
        state=state,
        authorization_url=authorization_url,
    )


def parse_authorization_input(input_str: str) -> tuple[Optional[str], Optional[str]]:
    """
    Parse authorization input in multiple formats.

    Accepts:
    - Full callback URL with query parameters
    - code#state format
    - Query string format

    Returns:
        Tuple of (code, state) or (None, None) if parsing fails.
    """
    input_str = input_str.strip()

    # Try parsing as URL
    if input_str.startswith("http"):
        parsed = urlparse(input_str)
        params = parse_qs(parsed.query)
        code = params.get("code", [None])[0]
        state = params.get("state", [None])[0]
        if code and state:
            return code, state

    # Try code#state format
    if "#" in input_str:
        parts = input_str.split("#")
        if len(parts) == 2:
            return parts[0], parts[1]

    # Try query string format
    if "=" in input_str:
        params = parse_qs(input_str)
        code = params.get("code", [None])[0]
        state = params.get("state", [None])[0]
        if code and state:
            return code, state

    return None, None


def decode_jwt(token: str) -> Optional[dict]:
    """
    Decode a JWT token without verification.

    Used to extract account information from the access token.
    """
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None

        # Decode the payload (second part)
        payload = parts[1]
        # Add padding if needed
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += "=" * padding

        decoded = base64.urlsafe_b64decode(payload)
        return json.loads(decoded)
    except Exception as e:
        logger.warning(f"Failed to decode JWT: {e}")
        return None


async def exchange_authorization_code(
    code: str,
    pkce_verifier: str,
) -> TokenResult:
    """
    Exchange an authorization code for access and refresh tokens.

    Args:
        code: The authorization code from the OAuth callback.
        pkce_verifier: The PKCE code verifier used during authorization.

    Returns:
        TokenResult with tokens on success, or error message on failure.
    """
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                OAUTH_TOKEN_ENDPOINT,
                data={
                    "grant_type": "authorization_code",
                    "client_id": OAUTH_CLIENT_ID,
                    "code": code,
                    "redirect_uri": OAUTH_REDIRECT_URI,
                    "code_verifier": pkce_verifier,
                },
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            )

            if response.status_code != HTTP_STATUS_OK:
                error_data = response.json() if response.content else {}
                error_msg = error_data.get("error_description", error_data.get("error", "Token exchange failed"))
                logger.error(f"Token exchange failed: {response.status_code} - {error_msg}")
                return TokenResult(success=False, error=error_msg)

            data = response.json()
            access_token = data.get("access_token")
            refresh_token = data.get("refresh_token")
            expires_in = data.get("expires_in", 3600)

            if not access_token:
                return TokenResult(success=False, error="No access token in response")

            # Extract account info from JWT
            account_info = decode_jwt(access_token)

            return TokenResult(
                success=True,
                access_token=access_token,
                refresh_token=refresh_token,
                expires_in=expires_in,
                account_info=account_info,
            )

    except httpx.RequestError as e:
        logger.error(f"Token exchange request failed: {e}")
        return TokenResult(success=False, error=f"Request failed: {str(e)}")
    except Exception as e:
        logger.error(f"Token exchange error: {e}")
        return TokenResult(success=False, error=str(e))


async def refresh_access_token(refresh_token: str) -> TokenResult:
    """
    Refresh an expired access token using a refresh token.

    Args:
        refresh_token: The refresh token from a previous authentication.

    Returns:
        TokenResult with new tokens on success, or error message on failure.
    """
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                OAUTH_TOKEN_ENDPOINT,
                data={
                    "grant_type": "refresh_token",
                    "client_id": OAUTH_CLIENT_ID,
                    "refresh_token": refresh_token,
                },
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            )

            if response.status_code != HTTP_STATUS_OK:
                error_data = response.json() if response.content else {}
                error_msg = error_data.get("error_description", error_data.get("error", "Token refresh failed"))
                logger.error(f"Token refresh failed: {response.status_code} - {error_msg}")
                return TokenResult(success=False, error=error_msg)

            data = response.json()
            access_token = data.get("access_token")
            new_refresh_token = data.get("refresh_token", refresh_token)
            expires_in = data.get("expires_in", 3600)

            if not access_token:
                return TokenResult(success=False, error="No access token in response")

            # Extract account info from JWT
            account_info = decode_jwt(access_token)

            return TokenResult(
                success=True,
                access_token=access_token,
                refresh_token=new_refresh_token,
                expires_in=expires_in,
                account_info=account_info,
            )

    except httpx.RequestError as e:
        logger.error(f"Token refresh request failed: {e}")
        return TokenResult(success=False, error=f"Request failed: {str(e)}")
    except Exception as e:
        logger.error(f"Token refresh error: {e}")
        return TokenResult(success=False, error=str(e))


# Global storage for pending OAuth flows
_pending_flows: dict[str, AuthorizationFlow] = {}


def store_pending_flow(state: str, flow: AuthorizationFlow):
    """Store a pending OAuth flow by state."""
    _pending_flows[state] = flow


def get_pending_flow(state: str) -> Optional[AuthorizationFlow]:
    """Retrieve and remove a pending OAuth flow by state."""
    return _pending_flows.pop(state, None)


def clear_expired_flows():
    """Clear expired pending flows (older than 10 minutes)."""
    # In a production environment, flows should have timestamps
    # For now, we just limit the size
    if len(_pending_flows) > 100:
        # Remove oldest entries
        keys_to_remove = list(_pending_flows.keys())[:-50]
        for key in keys_to_remove:
            _pending_flows.pop(key, None)
