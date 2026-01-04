"""
OAuth routes for OpenAI authentication.

Provides endpoints for:
- Starting OAuth flow
- Handling OAuth callbacks
- Refreshing tokens
- Checking OAuth status
- Logging out
"""

import time
import logging
from typing import Optional
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel

from ..services.openai_oauth import (
    create_authorization_flow,
    exchange_authorization_code,
    refresh_access_token,
    store_pending_flow,
    get_pending_flow,
    OAuthTokens,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/oauth")

# In-memory token storage (in production, use a database or secure storage)
_oauth_tokens: dict[str, OAuthTokens] = {}


class OAuthStartResponse(BaseModel):
    """Response for starting OAuth flow."""
    authorization_url: str
    state: str


class OAuthTokenResponse(BaseModel):
    """Response containing OAuth token info."""
    authenticated: bool
    expires_at: Optional[float] = None
    account_email: Optional[str] = None
    account_name: Optional[str] = None


class OAuthRefreshRequest(BaseModel):
    """Request to refresh tokens."""
    pass  # No body needed, uses stored refresh token


class OAuthRefreshResponse(BaseModel):
    """Response after refreshing tokens."""
    success: bool
    expires_at: Optional[float] = None
    error: Optional[str] = None


class OAuthCallbackRequest(BaseModel):
    """Request for manual OAuth callback."""
    code: str
    state: str


class OAuthCallbackResponse(BaseModel):
    """Response from OAuth callback."""
    success: bool
    account_email: Optional[str] = None
    account_name: Optional[str] = None
    error: Optional[str] = None


class OAuthLogoutResponse(BaseModel):
    """Response from logout."""
    success: bool


@router.get("/openai/start", response_model=OAuthStartResponse)
async def start_oauth_flow():
    """
    Start the OpenAI OAuth flow.

    Returns the authorization URL that the user should open in their browser.
    """
    try:
        flow = create_authorization_flow()
        store_pending_flow(flow.state, flow)

        logger.info(f"Started OAuth flow with state: {flow.state[:8]}...")

        return OAuthStartResponse(
            authorization_url=flow.authorization_url,
            state=flow.state,
        )
    except Exception as e:
        logger.error(f"Failed to start OAuth flow: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/openai/callback")
async def oauth_callback(
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    error_description: Optional[str] = Query(None),
):
    """
    Handle OAuth callback from OpenAI.

    This endpoint is called by OpenAI after the user authorizes the application.
    """
    if error:
        error_msg = error_description or error
        logger.error(f"OAuth callback error: {error_msg}")
        return HTMLResponse(content=_get_error_html(error_msg))

    if not code or not state:
        return HTMLResponse(content=_get_error_html("Missing code or state parameter"))

    # Get the pending flow
    flow = get_pending_flow(state)
    if not flow:
        return HTMLResponse(content=_get_error_html("Invalid or expired state. Please try again."))

    # Exchange the code for tokens
    result = await exchange_authorization_code(code, flow.pkce.verifier)

    if not result.success:
        return HTMLResponse(content=_get_error_html(result.error or "Token exchange failed"))

    # Store the tokens
    expires_at = time.time() + (result.expires_in or 3600)
    _oauth_tokens["default"] = OAuthTokens(
        access_token=result.access_token,
        refresh_token=result.refresh_token,
        expires_at=expires_at,
        account_info=result.account_info,
    )

    account_email = result.account_info.get("email", "") if result.account_info else ""
    logger.info(f"OAuth authentication successful for: {account_email}")

    return HTMLResponse(content=_get_success_html(account_email))


@router.post("/openai/callback", response_model=OAuthCallbackResponse)
async def oauth_callback_manual(request: OAuthCallbackRequest):
    """
    Handle manual OAuth callback (for when automatic redirect doesn't work).

    Accepts the code and state from the user.
    """
    # Get the pending flow
    flow = get_pending_flow(request.state)
    if not flow:
        return OAuthCallbackResponse(
            success=False,
            error="Invalid or expired state. Please start a new OAuth flow.",
        )

    # Exchange the code for tokens
    result = await exchange_authorization_code(request.code, flow.pkce.verifier)

    if not result.success:
        return OAuthCallbackResponse(
            success=False,
            error=result.error or "Token exchange failed",
        )

    # Store the tokens
    expires_at = time.time() + (result.expires_in or 3600)
    _oauth_tokens["default"] = OAuthTokens(
        access_token=result.access_token,
        refresh_token=result.refresh_token,
        expires_at=expires_at,
        account_info=result.account_info,
    )

    account_info = result.account_info or {}
    return OAuthCallbackResponse(
        success=True,
        account_email=account_info.get("email"),
        account_name=account_info.get("name"),
    )


@router.get("/openai/status", response_model=OAuthTokenResponse)
async def get_oauth_status():
    """
    Check if OAuth is authenticated and get account info.
    """
    tokens = _oauth_tokens.get("default")

    if not tokens:
        return OAuthTokenResponse(authenticated=False)

    # Check if token is expired
    if time.time() >= tokens.expires_at:
        # Try to refresh
        if tokens.refresh_token:
            result = await refresh_access_token(tokens.refresh_token)
            if result.success:
                expires_at = time.time() + (result.expires_in or 3600)
                _oauth_tokens["default"] = OAuthTokens(
                    access_token=result.access_token,
                    refresh_token=result.refresh_token,
                    expires_at=expires_at,
                    account_info=result.account_info,
                )
                tokens = _oauth_tokens["default"]
            else:
                # Refresh failed, clear tokens
                _oauth_tokens.pop("default", None)
                return OAuthTokenResponse(authenticated=False)
        else:
            # No refresh token, clear tokens
            _oauth_tokens.pop("default", None)
            return OAuthTokenResponse(authenticated=False)

    account_info = tokens.account_info or {}
    return OAuthTokenResponse(
        authenticated=True,
        expires_at=tokens.expires_at,
        account_email=account_info.get("email"),
        account_name=account_info.get("name"),
    )


@router.post("/openai/refresh", response_model=OAuthRefreshResponse)
async def refresh_tokens():
    """
    Refresh the OAuth access token.
    """
    tokens = _oauth_tokens.get("default")

    if not tokens or not tokens.refresh_token:
        return OAuthRefreshResponse(
            success=False,
            error="No refresh token available",
        )

    result = await refresh_access_token(tokens.refresh_token)

    if not result.success:
        return OAuthRefreshResponse(
            success=False,
            error=result.error,
        )

    expires_at = time.time() + (result.expires_in or 3600)
    _oauth_tokens["default"] = OAuthTokens(
        access_token=result.access_token,
        refresh_token=result.refresh_token,
        expires_at=expires_at,
        account_info=result.account_info,
    )

    return OAuthRefreshResponse(
        success=True,
        expires_at=expires_at,
    )


@router.post("/openai/logout", response_model=OAuthLogoutResponse)
async def logout():
    """
    Log out of OpenAI OAuth.

    Clears stored tokens.
    """
    _oauth_tokens.pop("default", None)
    logger.info("OAuth tokens cleared")
    return OAuthLogoutResponse(success=True)


def get_oauth_access_token() -> Optional[str]:
    """
    Get the current OAuth access token if available and valid.

    This function is used by other parts of the application to get the token.
    Returns None if not authenticated or token is expired.
    """
    tokens = _oauth_tokens.get("default")

    if not tokens:
        return None

    # Check if token is expired (with 60 second buffer)
    if time.time() >= (tokens.expires_at - 60):
        return None

    return tokens.access_token


def get_oauth_tokens() -> Optional[OAuthTokens]:
    """
    Get the current OAuth tokens if available.

    Returns the full token object for advanced use cases.
    """
    return _oauth_tokens.get("default")


def _get_success_html(email: str = "") -> str:
    """Return success page HTML."""
    email_display = f"<p>Logged in as: <strong>{email}</strong></p>" if email else ""
    return f"""<!DOCTYPE html>
<html>
<head>
    <title>Authentication Successful - Policy Radar</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #d4a574 0%, #8b6914 100%);
        }}
        .container {{
            background: #fdf8f0;
            padding: 40px;
            border-radius: 16px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            text-align: center;
            max-width: 400px;
            border: 2px solid #c9a86c;
        }}
        .success-icon {{
            font-size: 64px;
            margin-bottom: 20px;
        }}
        h1 {{ color: #10b981; margin-bottom: 10px; font-family: 'Georgia', serif; }}
        p {{ color: #5c4a32; }}
        .email {{ color: #8b6914; font-weight: bold; }}
    </style>
    <script>
        // Auto-close after 3 seconds
        setTimeout(function() {{
            window.close();
        }}, 3000);
    </script>
</head>
<body>
    <div class="container">
        <div class="success-icon">✓</div>
        <h1>Authentication Successful!</h1>
        {email_display}
        <p>You can close this window and return to Policy Radar.</p>
        <p><small>This window will close automatically...</small></p>
    </div>
</body>
</html>"""


def _get_error_html(error: str) -> str:
    """Return error page HTML."""
    return f"""<!DOCTYPE html>
<html>
<head>
    <title>Authentication Failed - Policy Radar</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #d4a574 0%, #8b6914 100%);
        }}
        .container {{
            background: #fdf8f0;
            padding: 40px;
            border-radius: 16px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            text-align: center;
            max-width: 400px;
            border: 2px solid #c9a86c;
        }}
        .error-icon {{
            font-size: 64px;
            margin-bottom: 20px;
        }}
        h1 {{ color: #ef4444; margin-bottom: 10px; font-family: 'Georgia', serif; }}
        p {{ color: #5c4a32; }}
        .error-msg {{ color: #dc2626; font-size: 14px; margin-top: 15px; padding: 10px; background: #fef2f2; border-radius: 8px; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="error-icon">✗</div>
        <h1>Authentication Failed</h1>
        <p>There was a problem with the authentication process.</p>
        <p class="error-msg">{error}</p>
        <p><small>Please close this window and try again.</small></p>
    </div>
</body>
</html>"""
