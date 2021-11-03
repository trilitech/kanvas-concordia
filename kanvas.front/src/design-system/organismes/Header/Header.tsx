import styled from '@emotion/styled';
import { FlexSpacerProps } from '../../atoms/FlexSpacer';

import { Box } from '@mui/system';
import { FC, useEffect, useState } from 'react';
import { Theme } from '@mui/material';
import { KukaiEmbed } from 'kukai-embed';
import { StickyLogo } from '../../atoms/StickyLogo';
import { Menu } from '../../molecules/Menu';
import { useHistory } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { GET_LOGGED_USER } from '../../../api/queries/user';
import { IUser } from '../../../interfaces/user';

export interface HeaderProps {
    user?: { role: string };
    embedKukai?: KukaiEmbed;
    selectedTheme: string;
    notifications?: number;
    switchTheme: Function;
    onLogout?: () => void;
    onCreateAccount?: () => void;
}

const StyledBox = styled(Box)<{theme?: Theme}>`
    margin-bottom: -6rem;
    color: ${props => props.theme.palette.text.primary};
    
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);

    background-color: ${props => props.theme.header.background};
    position: sticky;
    top: 0;
    z-index: 10;
    transition: padding-left 0.2s, padding-right 0.2s;
    padding-left: 3rem;

    @media (max-width: 900px) {
        padding-left: 1.5rem;
        padding-right: 1rem !important;
        transition: padding-left 0.2s, padding-right 0.2s;
    }

`

const Spacer = styled.div<FlexSpacerProps>`
    flex-grow: 1;
    flex-grow: 1;
    width: ${props => props.display ? '' : '0rem'};
    transition: width 0.2s;
`

export const Header : FC<HeaderProps> = ({ user, selectedTheme, onLogout, onCreateAccount, switchTheme, notifications, ...props}) => {
    
    const history = useHistory();

    // const loggedUser = useQuery(GET_LOGGED_USER)
    const loggedUser = {data: undefined, loading: false}
    const [isSearchOpen, setIsSearchOpen] = useState(false)
    const [currentLoggedUser, setCurrentLoggedUser] = useState<IUser | undefined>(undefined)

    useEffect(() => {
        if (loggedUser.data) {
            setCurrentLoggedUser(loggedUser.data)
        }
    }, [loggedUser])

    return (
        <StyledBox sx={{
            height: '6rem',
            display: 'flex',
            alignItems: 'center',
            paddingRight: '2rem'
        }}>
            <StickyLogo display={!isSearchOpen} />
            <Spacer display={!isSearchOpen} />
                
            <Menu loading={loggedUser.loading} user={currentLoggedUser} setSearchOpen={setIsSearchOpen} isSearchOpen={isSearchOpen} embedKukai={props.embedKukai} notifications={notifications} selectedTheme={selectedTheme} switchTheme={switchTheme} onLogout={onLogout} onCreateAccount={onCreateAccount} history={history}/>
        </StyledBox>
    )
}